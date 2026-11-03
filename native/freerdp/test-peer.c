#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <freerdp/freerdp.h>
#include <freerdp/peer.h>
#include <freerdp/input.h>
#include <freerdp/update.h>
#include <freerdp/settings.h>
#include <freerdp/constants.h>
#include <freerdp/channels/wtsvc.h>
#include <freerdp/crypto/certificate.h>
#include <freerdp/crypto/privatekey.h>
#include <winpr/wlog.h>
#include <winpr/ssl.h>
#include <winpr/sspi.h>

typedef struct {
  rdpContext context;
  UINT16 clipboardId;
  BYTE clipboardPacket[1024 * 1024];
  UINT32 clipboardLength;
  UINT16 dynamicId;
  BOOL channelsStarted;
  BOOL fileMode;
  UINT32 remoteFileMode;
  UINT32 requestedFormat;
  UINT32 clipboardOrigin;
  BOOL controlDown;
  BOOL shiftDown;
  UINT32 uploadCount;
  UINT32 uploadIndex;
  UINT32 uploadPosition;
  UINT32 uploadHash;
  UINT32 uploadSizes[4096];
  BOOL uploadDirectories[4096];
} PeerContext;

static UINT16 read_short(const BYTE* data) { return data[0] | ((UINT16)data[1] << 8); }
static void write_number(BYTE* data, UINT32 number) {
  data[0] = (BYTE)number; data[1] = (BYTE)(number >> 8); data[2] = (BYTE)(number >> 16); data[3] = (BYTE)(number >> 24);
}

static UINT32 read_number(const BYTE* data) { return data[0] | ((UINT32)data[1] << 8) | ((UINT32)data[2] << 16) | ((UINT32)data[3] << 24); }

static BOOL display_data(freerdp_peer* peer, const BYTE* data, size_t length) {
  PeerContext* context = (PeerContext*)peer->context;
  if (length >= 4 && data[0] == 0x50) {
    const BYTE create[] = "\x10\x01" "Microsoft::Windows::RDS::DisplayControl";
    return peer->SendChannelData(peer, context->dynamicId, create, sizeof(create));
  }
  if (length >= 6 && data[0] == 0x10 && data[1] == 1 && read_number(data + 2) == 0) {
    BYTE caps[22] = { 0x30, 1 };
    write_number(caps + 2, 5); write_number(caps + 6, 20);
    write_number(caps + 10, 1); write_number(caps + 14, 8192); write_number(caps + 18, 8192);
    printf("display-ready\n"); fflush(stdout);
    return peer->SendChannelData(peer, context->dynamicId, caps, sizeof(caps));
  }
  if (length == 58 && data[0] == 0x30 && data[1] == 1 && read_number(data + 2) == 2) {
    UINT32 width = read_number(data + 30), height = read_number(data + 34);
    UINT32 scale = read_number(data + 50), device = read_number(data + 54);
    printf("layout %u %u %u %u\n", width, height, scale, device); fflush(stdout);
    if (width == freerdp_settings_get_uint32(peer->context->settings, FreeRDP_DesktopWidth) && height == freerdp_settings_get_uint32(peer->context->settings, FreeRDP_DesktopHeight)) return TRUE;
    return freerdp_settings_set_uint32(peer->context->settings, FreeRDP_DesktopWidth, width) &&
      freerdp_settings_set_uint32(peer->context->settings, FreeRDP_DesktopHeight, height) &&
      peer->context->update->DesktopResize(peer->context);
  }
  return TRUE;
}

static BOOL send_clipboard(freerdp_peer* peer, UINT16 kind, UINT16 flags, const BYTE* payload, UINT32 length) {
  if (length > 1024 * 1024 - 8) return FALSE;
  BYTE* packet = calloc(1, (size_t)length + 8);
  if (!packet) return FALSE;
  packet[0] = (BYTE)kind; packet[2] = (BYTE)flags;
  write_number(packet + 4, length);
  if (length) memcpy(packet + 8, payload, length);
  BOOL result = peer->SendChannelData(peer, ((PeerContext*)peer->context)->clipboardId, packet, length + 8);
  free(packet);
  return result;
}

static BOOL announce_files(freerdp_peer* peer) {
  PeerContext* context = (PeerContext*)peer->context;
  context->clipboardOrigin = context->remoteFileMode == 8 ? 4 : 1;
  BYTE format[128] = { 0 };
  write_number(format, 0xc002);
  const WCHAR name[] = L"FileGroupDescriptorW";
  memcpy(format + 4, name, sizeof(name));
  if (context->remoteFileMode == 8) {
    UINT32 offset = 4 + sizeof(name);
    write_number(format + offset, 0xc003);
    const WCHAR effect[] = L"Preferred DropEffect";
    memcpy(format + offset + 4, effect, sizeof(effect));
    return send_clipboard(peer, 2, 0, format, offset + 4 + sizeof(effect));
  }
  return send_clipboard(peer, 2, 0, format, 4 + sizeof(name));
}

static BOOL send_file_descriptors(freerdp_peer* peer) {
  PeerContext* context = (PeerContext*)peer->context;
  BYTE data[4 + 5 * 592] = { 0 };
  write_number(data, 5);
  const WCHAR* names[] = { L"\x8fdc\x7aef\x76ee\x5f55", L"\x8fdc\x7aef\x76ee\x5f55\\\x5185\x5bb9\xd83d\xde42.bin", L"\x8fdc\x7aef\x76ee\x5f55\\\x7a7a\x6587\x4ef6.txt", L"\x6839\x6587\x4ef6.txt", L"\x8fdc\x7aef\x76ee\x5f55\\\x7a7a\x76ee\x5f55" };
  UINT32 sizes[] = { 0, 1024 * 1024 + 37, 0, 13, 0 };
  for (UINT32 index = 0; index < 5; index++) {
    BYTE* descriptor = data + 4 + index * 592;
    write_number(descriptor, 4 | 0x40 | 0x80000000);
    write_number(descriptor + 36, index == 0 || index == 4 ? 0x10 : 0x80);
    write_number(descriptor + 68, sizes[index]);
    const WCHAR* name = context->remoteFileMode == 2 && index == 0 ? L"..\\escaped" : names[index];
    memcpy(descriptor + 72, name, (wcslen(name) + 1) * 2);
  }
  return send_clipboard(peer, 5, 1, data, sizeof(data));
}

static BOOL request_upload(freerdp_peer* peer) {
  PeerContext* context = (PeerContext*)peer->context;
  while (context->uploadIndex < context->uploadCount && context->uploadDirectories[context->uploadIndex]) context->uploadIndex++;
  if (context->uploadIndex >= context->uploadCount) { printf("files-upload-complete\n"); fflush(stdout); return TRUE; }
  UINT32 remaining = context->uploadSizes[context->uploadIndex] - context->uploadPosition;
  BYTE request[24];
  write_number(request, context->uploadIndex + 101);
  write_number(request + 4, context->uploadIndex);
  write_number(request + 8, remaining ? 2 : 1);
  write_number(request + 12, context->uploadPosition);
  write_number(request + 16, 0);
  write_number(request + 20, remaining ? (remaining < 65536 ? remaining : 65536) : 8);
  return send_clipboard(peer, 8, 0, request, sizeof(request));
}

static BOOL file_channel(freerdp_peer* peer, const BYTE* packet, UINT32 length) {
  PeerContext* context = (PeerContext*)peer->context;
  UINT16 kind = read_short(packet);
  if (kind == 2) {
    UINT32 format = 0;
    for (UINT32 offset = 8; offset + 6 <= length;) {
      UINT32 current = read_number(packet + offset); offset += 4;
      if (current == 0xc001 || current == 13) format = current;
      while (offset + 2 <= length && read_short(packet + offset)) offset += 2;
      offset += 2;
    }
    context->requestedFormat = format;
    context->clipboardOrigin = 0;
    printf("client-clipboard-format %u\n", format); fflush(stdout);
    BYTE request[4]; write_number(request, format);
    return send_clipboard(peer, 3, 1, NULL, 0) && (!format || send_clipboard(peer, 4, 0, request, 4));
  }
  if (kind == 4 && length == 12) {
    if (read_number(packet + 8) == 0xc002) { printf("remote-descriptors-requested\n"); fflush(stdout); return send_file_descriptors(peer); }
    const WCHAR text[] = L"QA remote text";
    return send_clipboard(peer, 5, 1, (const BYTE*)text, sizeof(text));
  }
  if (kind == 5 && context->requestedFormat == 0xc001 && (read_short(packet + 2) & 1)) {
    if (length < 12) return FALSE;
    context->uploadCount = read_number(packet + 8);
    if (context->uploadCount > 4096 || length != 12 + context->uploadCount * 592) return FALSE;
    for (UINT32 index = 0; index < context->uploadCount; index++) {
      const BYTE* descriptor = packet + 12 + index * 592;
      context->uploadDirectories[index] = !!(read_number(descriptor + 36) & 0x10);
      context->uploadSizes[index] = read_number(descriptor + 68);
      printf("file-descriptor %u %u %u ", index, context->uploadDirectories[index], context->uploadSizes[index]);
      for (UINT32 offset = 72; offset < 592 && read_short(descriptor + offset); offset += 2) printf("%04x", read_short(descriptor + offset));
      printf("\n");
    }
    fflush(stdout);
    context->uploadIndex = 0; context->uploadPosition = 0; context->uploadHash = 2166136261u;
    return request_upload(peer);
  }
  if (kind == 5 && context->requestedFormat == 13 && (read_short(packet + 2) & 1)) {
    printf("client-text ");
    for (UINT32 offset = 8; offset + 1 < length && read_short(packet + offset); offset += 2) printf("%04x", read_short(packet + offset));
    printf("\n"); fflush(stdout);
    return TRUE;
  }
  if (kind == 9) {
    if (!(read_short(packet + 2) & 1)) { printf("file-upload-rejected\n"); fflush(stdout); return TRUE; }
    UINT32 size = context->uploadSizes[context->uploadIndex];
    if (size) {
      for (UINT32 offset = 12; offset < length; offset++) context->uploadHash = (context->uploadHash ^ packet[offset]) * 16777619u;
      context->uploadPosition += length - 12;
    }
    if (context->uploadPosition >= size) {
      printf("file-upload %u %u %u\n", context->uploadIndex, size, context->uploadHash); fflush(stdout);
      context->uploadIndex++; context->uploadPosition = 0; context->uploadHash = 2166136261u;
    }
    return request_upload(peer);
  }
  if (kind == 8 && length >= 32) {
    printf("remote-content-requested\n"); fflush(stdout);
    if (context->remoteFileMode == 6) return TRUE;
    UINT32 stream = read_number(packet + 8), index = read_number(packet + 12), flag = read_number(packet + 16);
    UINT32 position = read_number(packet + 20), requested = read_number(packet + 28);
    UINT32 size = index == 1 ? 1024 * 1024 + 37 : index == 3 ? 13 : 0;
    if (requested > 256 * 1024 || position > size || context->remoteFileMode == 5) { BYTE response[4]; write_number(response, stream); return send_clipboard(peer, 9, 2, response, 4); }
    UINT32 count = flag == 1 ? 8 : (requested < size - position ? requested : size - position);
    if (context->remoteFileMode == 3 && flag == 2) count = 0;
    BYTE* response = calloc(1, (size_t)count + 4);
    if (!response) return FALSE;
    write_number(response, stream);
    if (flag == 1) write_number(response + 4, size);
    else for (UINT32 offset = 0; offset < count; offset++) response[4 + offset] = (BYTE)(((position + offset) * 31u + index * 17u) % 251u);
    BOOL result = send_clipboard(peer, 9, 1, response, count + 4);
    free(response); return result;
  }
  return TRUE;
}

static BOOL announce_remote(freerdp_peer* peer) {
  ((PeerContext*)peer->context)->clipboardOrigin = 2;
  const BYTE format[] = { 13, 0, 0, 0, 0, 0 };
  return send_clipboard(peer, 2, 0, format, sizeof(format));
}

static BOOL channel_data(freerdp_peer* peer, UINT16 channel, const BYTE* data, size_t length, UINT32 flags, size_t total) {
  PeerContext* context = (PeerContext*)peer->context;
  if (channel == context->dynamicId) return display_data(peer, data, length);
  if (channel != context->clipboardId) return TRUE;
  if (flags & CHANNEL_FLAG_FIRST) context->clipboardLength = 0;
  if (total > sizeof(context->clipboardPacket) || context->clipboardLength + length > sizeof(context->clipboardPacket)) return FALSE;
  memcpy(context->clipboardPacket + context->clipboardLength, data, length);
  context->clipboardLength += (UINT32)length;
  if (!(flags & CHANNEL_FLAG_LAST)) return TRUE;
  if (context->clipboardLength < 8) return FALSE;
  const BYTE* packet = context->clipboardPacket;
  if (context->fileMode) return file_channel(peer, packet, context->clipboardLength);
  UINT16 kind = read_short(packet);
  if (kind == 2) {
    const BYTE request[] = { 13, 0, 0, 0 };
    return send_clipboard(peer, 3, 1, NULL, 0) && send_clipboard(peer, 4, 0, request, sizeof(request));
  }
  if (kind == 4) {
    const WCHAR text[] = { 'Q', 'A', '-', 0x8fdc, 0x7aef, 0xd83d, 0xde42, 13, 10, 0 };
    return send_clipboard(peer, 5, 1, (const BYTE*)text, sizeof(text));
  }
  if (kind == 5 && (read_short(packet + 2) & 1)) {
    printf("clipboard ");
    for (UINT32 offset = 8; offset + 1 < context->clipboardLength; offset += 2) printf("%04x", read_short(packet + offset));
    printf("\n"); fflush(stdout);
    return announce_remote(peer);
  }
  return TRUE;
}

static BOOL keyboard(rdpInput* input, UINT16 flags, UINT8 code) {
  PeerContext* context = (PeerContext*)input->context;
  BOOL down = !(flags & KBD_FLAGS_RELEASE);
  if (code == 0x1d) context->controlDown = down;
  if (code == 0x2a || code == 0x36) context->shiftDown = down;
  if (context->fileMode && down && ((code == 0x2f && context->controlDown) || (code == 0x52 && context->shiftDown))) { printf("paste-origin %u\n", context->clipboardOrigin); fflush(stdout); }
  if (context->fileMode && down && code == 0x41) {
    context->clipboardOrigin = 3;
    const BYTE format[] = { 8, 0, 0, 0, 0, 0 };
    return send_clipboard(input->context->peer, 2, 0, format, sizeof(format));
  }
  if (context->fileMode && down && code == 0x42) { context->remoteFileMode = 8; return announce_files(input->context->peer); }
  if (context->fileMode && !(flags & KBD_FLAGS_RELEASE) && code >= 0x3b && code <= 0x40) {
    context->remoteFileMode = code - 0x3a;
    if (code == 0x3e) return announce_remote(input->context->peer);
    return announce_files(input->context->peer);
  }
  printf("key %u %u\n", flags, code); fflush(stdout);
  return TRUE;
}

static BOOL unicode_key(rdpInput* input, UINT16 flags, UINT16 code) {
  (void)input;
  printf("unicode %u %u\n", flags, code); fflush(stdout);
  return TRUE;
}

static BOOL mouse(rdpInput* input, UINT16 flags, UINT16 horizontal, UINT16 vertical) {
  (void)input;
  printf("mouse %u %u %u\n", flags, horizontal, vertical); fflush(stdout);
  return TRUE;
}

static BOOL extended_mouse(rdpInput* input, UINT16 flags, UINT16 horizontal, UINT16 vertical) {
  (void)input;
  printf("mousex %u %u %u\n", flags, horizontal, vertical); fflush(stdout);
  return TRUE;
}

static BOOL connected(freerdp_peer* peer) { (void)peer; return TRUE; }

static BOOL logon(freerdp_peer* peer, const SEC_WINNT_AUTH_IDENTITY* identity, BOOL automatic) {
  (void)peer; (void)identity;
  printf("logon %u\n", automatic); fflush(stdout);
  return TRUE;
}

static BOOL activate(freerdp_peer* peer) {
  PeerContext* context = (PeerContext*)peer->context;
  if (!context->channelsStarted) {
    context->channelsStarted = TRUE;
    context->clipboardId = WTSChannelGetId(peer, "cliprdr");
    if (context->clipboardId) {
      BYTE caps[] = { 1, 0, 0, 0, 1, 0, 12, 0, 2, 0, 0, 0, 2, 0, 0, 0 };
      if (context->fileMode) caps[12] = 0x2e;
      if (!send_clipboard(peer, 7, 0, caps, sizeof(caps)) || !send_clipboard(peer, 1, 0, NULL, 0)) return FALSE;
    }
    context->dynamicId = WTSChannelGetId(peer, "drdynvc");
    if (context->dynamicId) {
      const BYTE caps[] = { 0x50, 0, 1, 0 };
      if (!peer->SendChannelData(peer, context->dynamicId, caps, sizeof(caps))) return FALSE;
    }
  }
  BYTE pixels[16 * 16 * 4];
  for (size_t offset = 0; offset < sizeof(pixels); offset += 4) {
    pixels[offset] = 17; pixels[offset + 1] = 123; pixels[offset + 2] = 231; pixels[offset + 3] = 0;
  }
  BITMAP_DATA rectangle = { 0 };
  rectangle.destLeft = 10; rectangle.destTop = 20;
  rectangle.destRight = 25; rectangle.destBottom = 35;
  rectangle.width = 16; rectangle.height = 16; rectangle.bitsPerPixel = 32;
  rectangle.bitmapLength = sizeof(pixels);
  rectangle.cbScanWidth = 64;
  rectangle.cbUncompressedSize = sizeof(pixels);
  rectangle.bitmapDataStream = pixels;
  BITMAP_UPDATE update = { .number = 1, .rectangles = &rectangle, .skipCompression = TRUE };
  printf("activated\n"); fflush(stdout);
  return peer->context->update->BitmapUpdate(peer->context, &update);
}

int main(int argc, char** argv) {
  if ((argc != 5 && argc != 6) || !WLog_SetLogLevel(WLog_GetRoot(), WLOG_ERROR) || !winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT)) return 2;
  if (!InitSecurityInterfaceEx(SSPI_INTERFACE_WINPR)) return 2;
  WSADATA startup;
  if (WSAStartup(MAKEWORD(2, 2), &startup)) return 3;
  SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  struct sockaddr_in address = { 0 };
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (listener == INVALID_SOCKET || bind(listener, (struct sockaddr*)&address, sizeof(address)) || listen(listener, 1)) return 4;
  int addressLength = sizeof(address);
  if (getsockname(listener, (struct sockaddr*)&address, &addressLength)) return 4;
  printf("port %u\n", ntohs(address.sin_port)); fflush(stdout);
  SOCKET connection = accept(listener, NULL, NULL);
  closesocket(listener);
  if (connection == INVALID_SOCKET || connection > INT_MAX) return 5;
  freerdp_peer* peer = freerdp_peer_new((int)connection);
  if (!peer) return 6;
  peer->ContextSize = sizeof(PeerContext);
  if (!freerdp_peer_context_new(peer)) return 6;
  ((PeerContext*)peer->context)->fileMode = argc == 6;
  rdpSettings* settings = peer->context->settings;
  rdpPrivateKey* key = freerdp_key_new_from_file_enc(argv[2], NULL);
  rdpCertificate* certificate = freerdp_certificate_new_from_file(argv[1]);
  if (!key || !certificate) return 7;
  BOOL legacy = atoi(argv[3]) == 1;
  BOOL nla = atoi(argv[3]) == 2;
  if (!freerdp_settings_set_pointer_len(settings, FreeRDP_RdpServerRsaKey, key, 1) ||
      !freerdp_settings_set_pointer_len(settings, FreeRDP_RdpServerCertificate, certificate, 1) ||
      !freerdp_settings_set_bool(settings, FreeRDP_RdpSecurity, legacy) ||
      !freerdp_settings_set_bool(settings, FreeRDP_TlsSecurity, !legacy) ||
      !freerdp_settings_set_bool(settings, FreeRDP_NlaSecurity, nla) ||
      !freerdp_settings_set_bool(settings, FreeRDP_HasExtendedMouseEvent, !getenv("OMNIDESK_QA_BASIC_POINTER")) ||
      !freerdp_settings_set_bool(settings, FreeRDP_HasHorizontalWheel, !getenv("OMNIDESK_QA_BASIC_POINTER")) ||
      !freerdp_settings_set_string(settings, FreeRDP_NtlmSamFile, argv[4]) ||
      !freerdp_settings_set_bool(settings, FreeRDP_ExtSecurity, FALSE) ||
      !freerdp_settings_set_bool(settings, FreeRDP_NetworkAutoDetect, FALSE) ||
      !freerdp_settings_set_bool(settings, FreeRDP_SupportHeartbeatPdu, FALSE) ||
      !freerdp_settings_set_bool(settings, FreeRDP_SupportMultitransport, FALSE) ||
      !freerdp_settings_set_uint32(settings, FreeRDP_EncryptionLevel, ENCRYPTION_LEVEL_CLIENT_COMPATIBLE) ||
      !freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32) ||
      !freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, FALSE)) return 8;
  peer->Activate = activate;
  peer->PostConnect = connected;
  peer->Logon = logon;
  peer->ReceiveChannelData = channel_data;
  peer->context->input->KeyboardEvent = keyboard;
  peer->context->input->UnicodeKeyboardEvent = unicode_key;
  peer->context->input->MouseEvent = mouse;
  peer->context->input->ExtendedMouseEvent = extended_mouse;
  if (!peer->Initialize(peer)) return 9;
  while (TRUE) {
    HANDLE events[16];
    DWORD count = peer->GetEventHandles(peer, events, 16);
    if (!count || WaitForMultipleObjects(count, events, FALSE, 30000) == WAIT_TIMEOUT || !peer->CheckFileDescriptor(peer)) break;
  }
  peer->Disconnect(peer);
  freerdp_peer_context_free(peer);
  freerdp_peer_free(peer);
  WSACleanup();
  return 0;
}
