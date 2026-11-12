// Exercise the real host callbacks without opening a remote session or writing the OS clipboard.
#define main omnidesk_host_main
#include "host.c"
#undef main
#include <assert.h>

static UINT requests;
static UINT send_list(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST* list) { (void)context; (void)list; return CHANNEL_RC_OK; }
static UINT send_response(CliprdrClientContext* context, const CLIPRDR_FORMAT_LIST_RESPONSE* response) { (void)context; (void)response; return CHANNEL_RC_OK; }
static UINT send_request(CliprdrClientContext* context, const CLIPRDR_FORMAT_DATA_REQUEST* request) { (void)context; assert(request->requestedFormatId == CF_UNICODETEXT); requests++; return CHANNEL_RC_OK; }

int main(int argc, char** argv) {
  assert(argc == 2);
  Host host = { 0 };
  CliprdrClientContext clipboard = { 0 };
  InitializeCriticalSection(&host.outputLock);
  InitializeCriticalSection(&host.clipboardLock);
  host.flags = 2;
  host.clipboard = &clipboard;
  host.clipboardReady = TRUE;
  clipboard.custom = &host;
  clipboard.ClientFormatList = send_list;
  clipboard.ClientFormatListResponse = send_response;
  clipboard.ClientFormatDataRequest = send_request;
  host.remoteClipboardGeneration = 7;
  host.pendingClipboardGeneration = 7;
  host.pendingClipboardFormat = CF_UNICODETEXT;
  host.remoteTextFormat = TRUE;
  if (!strcmp(argv[1], "reconnect")) {
    ChannelDisconnectedEventArgs disconnected = { 0 };
    disconnected.name = CLIPRDR_SVC_CHANNEL_NAME;
    channel_disconnected(&host, &disconnected);
    host.clipboard = &clipboard;
    CLIPRDR_FORMAT format = { .formatId = CF_UNICODETEXT };
    CLIPRDR_FORMAT_LIST formats = { .numFormats = 1, .formats = &format };
    assert(clipboard_formats(&clipboard, &formats) == CHANNEL_RC_OK);
    assert(requests == 1);
    fprintf(stderr, "PASS fresh text request after clipboard channel replacement\n");
  } else {
    if (!strcmp(argv[1], "local-file")) {
      BYTE data[12 + 592] = { 0 };
      write_u32(data, 1); write_u32(data + 4, 99); write_u32(data + 8, 1);
      host.remoteClipboardFlags = CB_STREAM_FILECLIP_ENABLED;
      assert(clipboard_file_command(&host, data, sizeof(data)));
    } else {
      const BYTE data[] = { 4, 'N', 'E', 'W' };
      assert(apply_command(&host, data, sizeof(data)));
    }
    const WCHAR old[] = L"STALE REMOTE RESPONSE";
    CLIPRDR_FORMAT_DATA_RESPONSE response = { 0 };
    response.common.msgFlags = CB_RESPONSE_OK;
    response.common.dataLen = sizeof(old);
    response.requestedFormatData = (const BYTE*)old;
    assert(clipboard_received(&clipboard, &response) == CHANNEL_RC_OK);
    assert(requests == 0);
    // A later fresh remote copy must still work, including after local file publication.
    CLIPRDR_FORMAT format = { .formatId = CF_UNICODETEXT };
    CLIPRDR_FORMAT_LIST formats = { .numFormats = 1, .formats = &format };
    assert(clipboard_formats(&clipboard, &formats) == CHANNEL_RC_OK);
    assert(requests == 1);
    const WCHAR fresh[] = L"FRESH REMOTE RESPONSE";
    response.common.dataLen = sizeof(fresh); response.requestedFormatData = (const BYTE*)fresh;
    assert(clipboard_received(&clipboard, &response) == CHANNEL_RC_OK);
    fprintf(stderr, "PASS local clipboard supersedes delayed remote data; later remote copy still works\n");
  }
  free(host.clipboardText); free(host.clipboardFiles);
  DeleteCriticalSection(&host.clipboardLock); DeleteCriticalSection(&host.outputLock);
  return 0;
}
