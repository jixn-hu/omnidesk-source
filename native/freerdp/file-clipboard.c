#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "file-clipboard.h"

#define CLIPBOARD_LIMIT (4u * 1024u * 1024u)

static UINT32 get_number(const BYTE* data) {
  return (UINT32)data[0] | ((UINT32)data[1] << 8) | ((UINT32)data[2] << 16) | ((UINT32)data[3] << 24);
}

static void put_number(BYTE* data, UINT32 value) {
  data[0] = (BYTE)value; data[1] = (BYTE)(value >> 8); data[2] = (BYTE)(value >> 16); data[3] = (BYTE)(value >> 24);
}

static BOOL pipe_read(BYTE* data, DWORD length) {
  while (length) {
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), data, length, &count, NULL) || !count) return FALSE;
    data += count; length -= count;
  }
  return TRUE;
}

static BOOL pipe_write(const BYTE* data, DWORD length) {
  while (length) {
    DWORD count = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), data, length, &count, NULL) || !count) return FALSE;
    data += count; length -= count;
  }
  return TRUE;
}

static BOOL open_clipboard(HWND window) {
  for (UINT attempt = 0; attempt < 20; attempt++) { if (OpenClipboard(window)) return TRUE; Sleep(25); }
  return FALSE;
}

static BYTE* read_files(HWND window, UINT32* length) {
  if (!open_clipboard(window)) return NULL;
  BYTE* data = calloc(1, CLIPBOARD_LIMIT);
  if (!data) { CloseClipboard(); return NULL; }
  put_number(data, GetClipboardSequenceNumber());
  HDROP drop = (HDROP)GetClipboardData(CF_HDROP);
  UINT count = drop ? DragQueryFileW(drop, 0xffffffff, NULL, 0) : 0;
  UINT32 offset = 8;
  BOOL valid = count <= 4096;
  for (UINT index = 0; valid && index < count; index++) {
    UINT chars = DragQueryFileW(drop, index, NULL, 0);
    if (!chars || chars > 32767) { valid = FALSE; break; }
    WCHAR* path = calloc((size_t)chars + 1, sizeof(WCHAR));
    if (!path) { valid = FALSE; break; }
    if (DragQueryFileW(drop, index, path, chars + 1) != chars) { free(path); valid = FALSE; break; }
    int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path, (int)chars, NULL, 0, NULL, NULL);
    if (bytes <= 0 || offset + 4 + (UINT32)bytes > CLIPBOARD_LIMIT) { free(path); valid = FALSE; break; }
    put_number(data + offset, (UINT32)bytes);
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path, (int)chars, (char*)data + offset + 4, bytes, NULL, NULL);
    offset += 4 + (UINT32)bytes;
    free(path);
  }
  CloseClipboard();
  if (!valid) { free(data); return NULL; }
  put_number(data + 4, count);
  *length = offset;
  return data;
}

static int write_files(HWND window, const BYTE* data, UINT32 length, UINT32* sequence) {
  if (length < 8 || length > CLIPBOARD_LIMIT) return 2;
  UINT32 count = get_number(data + 4);
  if (!count || count > 4096) return 2;
  WCHAR* names = calloc(CLIPBOARD_LIMIT, 1);
  if (!names) return 3;
  UINT32 offset = 8, chars = 0;
  for (UINT32 index = 0; index < count; index++) {
    if (offset + 4 > length) { free(names); return 2; }
    UINT32 bytes = get_number(data + offset); offset += 4;
    if (!bytes || bytes > 131072 || offset + bytes > length || memchr(data + offset, 0, bytes)) { free(names); return 2; }
    int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char*)data + offset, (int)bytes, NULL, 0);
    if (needed <= 0 || (chars + (UINT32)needed + 2) * 2 > CLIPBOARD_LIMIT) { free(names); return 2; }
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char*)data + offset, (int)bytes, names + chars, needed);
    chars += (UINT32)needed + 1;
    offset += bytes;
  }
  if (offset != length) { free(names); return 2; }
  SIZE_T size = sizeof(DROPFILES) + ((SIZE_T)chars + 1) * sizeof(WCHAR);
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size);
  if (!memory) { free(names); return 3; }
  DROPFILES* drop = GlobalLock(memory);
  if (!drop) { GlobalFree(memory); free(names); return 3; }
  drop->pFiles = sizeof(DROPFILES); drop->fWide = TRUE;
  memcpy((BYTE*)drop + sizeof(DROPFILES), names, ((SIZE_T)chars + 1) * sizeof(WCHAR));
  GlobalUnlock(memory); free(names);
  if (!open_clipboard(window)) { GlobalFree(memory); return 3; }
  if (GetClipboardSequenceNumber() != get_number(data)) { CloseClipboard(); GlobalFree(memory); return 4; }
  BOOL success = EmptyClipboard() && SetClipboardData(CF_HDROP, memory) != NULL;
  if (success) {
    HGLOBAL effect = GlobalAlloc(GMEM_MOVEABLE, sizeof(DWORD));
    DWORD* value = effect ? GlobalLock(effect) : NULL;
    if (value) {
      *value = 1; GlobalUnlock(effect);
      if (!SetClipboardData(RegisterClipboardFormatW(L"Preferred DropEffect"), effect)) GlobalFree(effect);
    } else if (effect) GlobalFree(effect);
  }
  if (success && sequence) *sequence = GetClipboardSequenceNumber();
  CloseClipboard();
  if (!success) GlobalFree(memory);
  return success ? 0 : 3;
}

int file_clipboard_cli(int argc, char** argv) {
  if (argc != 2 || (strcmp(argv[1], "--clipboard-read-files") && strcmp(argv[1], "--clipboard-write-files") && strcmp(argv[1], "--clipboard-selftest"))) return -1;
  HWINSTA station = NULL;
  HWINSTA original = NULL;
  HDESK desktop = NULL;
  HDESK originalDesktop = NULL;
  BOOL testing = !strcmp(argv[1], "--clipboard-selftest");
  if (testing) {
    original = GetProcessWindowStation(); originalDesktop = GetThreadDesktop(GetCurrentThreadId());
    station = CreateWindowStationW(NULL, 0, WINSTA_ALL_ACCESS, NULL);
    if (!station || !SetProcessWindowStation(station)) return 5;
    desktop = CreateDesktopW(L"OmniDeskClipboardQA", NULL, NULL, 0, GENERIC_ALL, NULL);
    if (!desktop || !SetThreadDesktop(desktop)) return 5;
  }
  HWND window = CreateWindowExW(0, L"STATIC", L"OmniDesk file clipboard", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, GetModuleHandleW(NULL), NULL);
  int result = 3;
  if (window) {
    UINT32 length = 0;
    BYTE* data = NULL;
    if (!strcmp(argv[1], "--clipboard-read-files")) {
      data = read_files(window, &length);
      result = data && pipe_write(data, length) ? 0 : 3;
    } else if (testing) {
      const char path[] = "C:\\OmniDesk-QA\\\xe4\xb8\xad\xe6\x96\x87.txt";
      length = 12 + (UINT32)strlen(path);
      data = calloc(1, length);
      if (data) {
        put_number(data, GetClipboardSequenceNumber()); put_number(data + 4, 1); put_number(data + 8, (UINT32)strlen(path)); memcpy(data + 12, path, strlen(path));
        UINT32 writtenSequence = 0;
        result = write_files(window, data, length, &writtenSequence);
        DestroyWindow(window);
        window = CreateWindowExW(0, L"STATIC", L"OmniDesk clipboard QA reader", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, GetModuleHandleW(NULL), NULL);
        UINT32 receivedLength = 0;
        BYTE* received = read_files(window, &receivedLength);
        if (!received || receivedLength != length || get_number(received) != writtenSequence || memcmp(received + 4, data + 4, length - 4) || write_files(window, data, length, NULL) != 4) result = 6;
        free(received);
      }
    } else {
      BYTE header[4];
      if (pipe_read(header, 4) && (length = get_number(header)) >= 8 && length <= CLIPBOARD_LIMIT) {
        data = malloc(length);
        if (data && pipe_read(data, length)) {
          UINT32 writtenSequence = 0;
          result = write_files(window, data, length, &writtenSequence);
          if (!result) { BYTE response[4]; put_number(response, writtenSequence); if (!pipe_write(response, sizeof(response))) result = 3; }
        }
      }
    }
    free(data); DestroyWindow(window);
  }
  if (testing) {
    SetThreadDesktop(originalDesktop); SetProcessWindowStation(original);
    if (desktop) CloseDesktop(desktop);
    if (station) CloseWindowStation(station);
  }
  return result;
}
