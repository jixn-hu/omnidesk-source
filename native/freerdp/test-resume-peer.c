#define main original_peer_main
#include "test-peer.c"
#undef main
#include <freerdp/session.h>
static const char* scenario;
static UINT32 connectionIndex;
static ULONGLONG activatedAt;
static BOOL resume_logon(freerdp_peer* peer, const SEC_WINNT_AUTH_IDENTITY* identity, BOOL automatic) {
  (void)identity;
  (void)peer; (void)automatic;
  return TRUE;
}
static BOOL resume_activate(freerdp_peer* peer) {
  const rdpSettings* settings = peer->context->settings;
  const char* username = freerdp_settings_get_string(settings, FreeRDP_Username);
  const char* password = freerdp_settings_get_string(settings, FreeRDP_Password);
  const ARC_CS_PRIVATE_PACKET* cookie = freerdp_settings_get_pointer(settings, FreeRDP_ClientAutoReconnectCookie);
  printf("client %u automatic=%u username=%u password=%u cookie=%u logon=%u\n", connectionIndex, freerdp_settings_get_bool(settings, FreeRDP_AutoLogonEnabled), username && username[0] ? 1 : 0, password && password[0] ? 1 : 0, cookie ? cookie->cbLen : 0, cookie ? cookie->logonId : 0); fflush(stdout);
  if (connectionIndex && (freerdp_settings_get_bool(settings, FreeRDP_AutoLogonEnabled) || (username && username[0]) || (password && password[0]) || !cookie || cookie->cbLen != 28 || cookie->logonId != 42)) { printf("UNSAFE_LOGON\n"); fflush(stdout); return FALSE; }
  if (strcmp(scenario,"nocookie")) {
    logon_info_ex info = {0}; info.haveCookie = TRUE; info.LogonId = connectionIndex && !strcmp(scenario,"takeover") ? 99 : 42;
    for (UINT32 x=0;x<16;x++) info.ArcRandomBits[x]=(BYTE)(x+1+connectionIndex);
    if (!peer->context->update->SaveSessionInfo(peer->context, INFO_TYPE_LOGON_EXTENDED_INF, &info)) return FALSE;
  }
  activatedAt = GetTickCount64();
  return activate(peer);
}
int main(int argc,char** argv) {
  if(argc!=4&&argc!=5)return 2;scenario=argv[3];
  if(!WLog_SetLogLevel(WLog_GetRoot(),WLOG_ERROR)||!winpr_InitializeSSL(WINPR_SSL_INIT_DEFAULT))return 3;
  if (!InitSecurityInterfaceEx(SSPI_INTERFACE_WINPR)) return 3;
  WSADATA startup;if(WSAStartup(MAKEWORD(2,2),&startup))return 3;
  SOCKET listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  if(listener==INVALID_SOCKET||bind(listener,(struct sockaddr*)&address,sizeof(address))||listen(listener,4))return 4;
  int length=sizeof(address);getsockname(listener,(struct sockaddr*)&address,&length);printf("port %u\n",ntohs(address.sin_port));fflush(stdout);
  for(connectionIndex=0;connectionIndex<3;connectionIndex++) {
    fd_set ready;FD_ZERO(&ready);FD_SET(listener,&ready);struct timeval timeout={7,0};if(select(0,&ready,NULL,NULL,&timeout)<=0)break;
    SOCKET socket=accept(listener,NULL,NULL);if(socket==INVALID_SOCKET)return 5;
    freerdp_peer* peer=freerdp_peer_new((int)socket);peer->ContextSize=sizeof(PeerContext);if(!freerdp_peer_context_new(peer))return 6;
    rdpSettings* settings=peer->context->settings;rdpPrivateKey* key=freerdp_key_new_from_file_enc(argv[2],NULL);rdpCertificate* certificate=freerdp_certificate_new_from_file(argv[1]);
    if(!key||!certificate||!freerdp_settings_set_pointer_len(settings,FreeRDP_RdpServerRsaKey,key,1)||!freerdp_settings_set_pointer_len(settings,FreeRDP_RdpServerCertificate,certificate,1)||!freerdp_settings_set_bool(settings,FreeRDP_RdpSecurity,FALSE)||!freerdp_settings_set_bool(settings,FreeRDP_TlsSecurity,TRUE)||!freerdp_settings_set_bool(settings,FreeRDP_NlaSecurity,!strcmp(scenario,"success-nla"))||!freerdp_settings_set_bool(settings,FreeRDP_ExtSecurity,FALSE)||!freerdp_settings_set_bool(settings,FreeRDP_NetworkAutoDetect,FALSE)||!freerdp_settings_set_bool(settings,FreeRDP_SupportHeartbeatPdu,FALSE)||!freerdp_settings_set_bool(settings,FreeRDP_SupportMultitransport,FALSE)||!freerdp_settings_set_uint32(settings,FreeRDP_EncryptionLevel,ENCRYPTION_LEVEL_CLIENT_COMPATIBLE)||!freerdp_settings_set_bool(settings,FreeRDP_SupportGraphicsPipeline,FALSE)||!freerdp_settings_set_uint32(settings,FreeRDP_ColorDepth,32))return 7;
    if(argc==5&&!freerdp_settings_set_string(settings,FreeRDP_NtlmSamFile,argv[4]))return 7;
    peer->PostConnect=connected;peer->Logon=resume_logon;peer->Activate=resume_activate;peer->ReceiveChannelData=channel_data;
    activatedAt=0;if(!peer->Initialize(peer))return 8;
    while(TRUE) {
      HANDLE events[16];DWORD count=peer->GetEventHandles(peer,events,16);if(!count)break;DWORD waited=WaitForMultipleObjects(count,events,FALSE,50);if(waited==WAIT_FAILED||(waited!=WAIT_TIMEOUT&&!peer->CheckFileDescriptor(peer)))break;
      if(activatedAt&&GetTickCount64()-activatedAt>(connectionIndex?1500:500)) {
        if(!connectionIndex&&!strcmp(scenario,"explicit")){freerdp_set_error_info(peer->context->rdp,ERRINFO_DISCONNECTED_BY_OTHER_CONNECTION);BOOL sent=freerdp_send_error_info(peer->context->rdp);(void)sent;Sleep(100);}
        shutdown(socket,SD_BOTH);break;
      }
    }
    peer->Disconnect(peer);freerdp_peer_context_free(peer);freerdp_peer_free(peer);
    if(connectionIndex&&(!strcmp(scenario,"success")||!strcmp(scenario,"success-nla")))break;
  }
  printf("accepted %u\n",connectionIndex);fflush(stdout);closesocket(listener);WSACleanup();return 0;
}
