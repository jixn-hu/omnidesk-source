#define UNICODE
#define _UNICODE
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shldisp.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "virtual-files.h"

#define LIMIT (4u * 1024u * 1024u)
typedef struct VirtualFiles {
  IDataObject data;
  IDataObjectAsyncCapability async;
  LONG refs;
  BYTE* descriptors;
  UINT32 length, count;
  UINT descriptorFormat, contentFormat, effectFormat;
  BOOL asyncMode, operation;
} VirtualFiles;
static UINT32 number(const BYTE* p) { return (UINT32)p[0] | ((UINT32)p[1] << 8) | ((UINT32)p[2] << 16) | ((UINT32)p[3] << 24); }
static void put(BYTE* p, UINT32 n) { p[0]=(BYTE)n; p[1]=(BYTE)(n>>8); p[2]=(BYTE)(n>>16); p[3]=(BYTE)(n>>24); }
static BOOL io(HANDLE pipe, void* data, DWORD length, BOOL writing) {
  BYTE* p=data;
  while (length) { DWORD count=0; BOOL ok=writing ? WriteFile(pipe,p,length,&count,NULL) : ReadFile(pipe,p,length,&count,NULL); if (!ok || !count) return FALSE; p+=count; length-=count; }
  return TRUE;
}
static BOOL send_message(UINT32 type, UINT32 value) {
  BYTE data[12]; put(data,8); put(data+4,type); put(data+8,value);
  return io(GetStdHandle(STD_OUTPUT_HANDLE),data,sizeof(data),TRUE);
}
static BYTE* read_frame(UINT32* length) {
  BYTE header[4]; if (!io(GetStdHandle(STD_INPUT_HANDLE),header,4,FALSE)) return NULL;
  *length=number(header); if (*length<4 || *length>LIMIT) return NULL;
  BYTE* data=malloc(*length); if (data && !io(GetStdHandle(STD_INPUT_HANDLE),data,*length,FALSE)) { free(data); data=NULL; } return data;
}
static VirtualFiles* object(IDataObject* self) { return CONTAINING_RECORD(self,VirtualFiles,data); }
static HRESULT STDMETHODCALLTYPE query(IDataObject* self, REFIID iid, void** result) {
  if (!result) return E_POINTER;
  *result=NULL;
  if (IsEqualIID(iid,&IID_IUnknown) || IsEqualIID(iid,&IID_IDataObject)) *result=self;
  else if (IsEqualIID(iid,&IID_IDataObjectAsyncCapability)) *result=&object(self)->async;
  else return E_NOINTERFACE;
  InterlockedIncrement(&object(self)->refs); return S_OK;
}
static ULONG STDMETHODCALLTYPE addref(IDataObject* self) { return (ULONG)InterlockedIncrement(&object(self)->refs); }
static ULONG STDMETHODCALLTYPE release(IDataObject* self) { VirtualFiles* files=object(self); LONG refs=InterlockedDecrement(&files->refs); if (!refs) { free(files->descriptors); free(files); } return (ULONG)refs; }
static HRESULT STDMETHODCALLTYPE query_data(IDataObject* self, FORMATETC* format) {
  VirtualFiles* files=object(self); if (!format) return E_POINTER;
  if (format->dwAspect!=DVASPECT_CONTENT) return DV_E_DVASPECT;
  if (format->ptd) return DV_E_DVTARGETDEVICE;
  if (format->cfFormat==files->contentFormat) {
    if (!(format->tymed & TYMED_ISTREAM)) return DV_E_TYMED;
    if (format->lindex < -1 || format->lindex >= (LONG)files->count) return DV_E_LINDEX;
    return S_OK;
  }
  if (format->cfFormat!=files->descriptorFormat && format->cfFormat!=files->effectFormat) return DV_E_FORMATETC;
  return (format->tymed & TYMED_HGLOBAL) ? S_OK : DV_E_TYMED;
}
static HRESULT STDMETHODCALLTYPE get_data(IDataObject* self, FORMATETC* format, STGMEDIUM* medium) {
  if (!medium) return E_POINTER;
  ZeroMemory(medium,sizeof(*medium));
  HRESULT result=query_data(self,format); if (FAILED(result)) return result;
  VirtualFiles* files=object(self);
  if (format->cfFormat==files->contentFormat) {
    if (format->lindex<0) return DV_E_LINDEX;
    const BYTE* descriptor=files->descriptors+4+(UINT32)format->lindex*592;
    if (number(descriptor+36) & FILE_ATTRIBUTE_DIRECTORY) return DV_E_LINDEX;
    if (!send_message(2,(UINT32)format->lindex)) return STG_E_READFAULT;
    UINT32 length=0; BYTE* data=read_frame(&length);
    if (!data || length<=4 || !number(data) || memchr(data+4,0,length-4)) { free(data); return STG_E_READFAULT; }
    int chars=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,(char*)data+4,(int)length-4,NULL,0);
    WCHAR* path=chars>0 && chars<32768 ? calloc((size_t)chars+1,sizeof(WCHAR)) : NULL;
    if (!path) { free(data); return STG_E_INVALIDNAME; }
    MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,(char*)data+4,(int)length-4,path,chars); free(data);
    DWORD attributes=GetFileAttributesW(path);
    if (attributes==INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) result=STG_E_FILENOTFOUND;
    else result=SHCreateStreamOnFileEx(path,STGM_READ | STGM_SHARE_DENY_WRITE,0,FALSE,NULL,&medium->pstm);
    free(path); if (SUCCEEDED(result)) medium->tymed=TYMED_ISTREAM; return result;
  }
  SIZE_T length=format->cfFormat==files->descriptorFormat ? files->length : sizeof(DWORD);
  HGLOBAL memory=GlobalAlloc(GMEM_MOVEABLE,length); if (!memory) return E_OUTOFMEMORY;
  void* data=GlobalLock(memory); if (!data) { GlobalFree(memory); return E_OUTOFMEMORY; }
  if (format->cfFormat==files->descriptorFormat) memcpy(data,files->descriptors,length); else *(DWORD*)data=DROPEFFECT_COPY;
  GlobalUnlock(memory); medium->tymed=TYMED_HGLOBAL; medium->hGlobal=memory; return S_OK;
}
static HRESULT STDMETHODCALLTYPE get_here(IDataObject* self, FORMATETC* format, STGMEDIUM* medium) { (void)self; (void)format; (void)medium; return E_NOTIMPL; }
static HRESULT STDMETHODCALLTYPE canonical(IDataObject* self, FORMATETC* input, FORMATETC* output) { (void)self; if (!input || !output) return E_POINTER; *output=*input; output->ptd=NULL; return DATA_S_SAMEFORMATETC; }
static HRESULT STDMETHODCALLTYPE set_data(IDataObject* self, FORMATETC* format, STGMEDIUM* medium, BOOL take) {
  (void)self; if (!format || !medium) return E_POINTER;
  if (format->cfFormat!=RegisterClipboardFormatW(CFSTR_PERFORMEDDROPEFFECT) && format->cfFormat!=RegisterClipboardFormatW(CFSTR_PASTESUCCEEDED) && format->cfFormat!=RegisterClipboardFormatW(CFSTR_LOGICALPERFORMEDDROPEFFECT)) return E_NOTIMPL;
  if (take) ReleaseStgMedium(medium);
  return S_OK;
}
static HRESULT STDMETHODCALLTYPE enumerate(IDataObject* self, DWORD direction, IEnumFORMATETC** result) {
  if (direction!=DATADIR_GET) return E_NOTIMPL;
  VirtualFiles* files=object(self);
  FORMATETC formats[]={{(CLIPFORMAT)files->descriptorFormat,NULL,DVASPECT_CONTENT,-1,TYMED_HGLOBAL},{(CLIPFORMAT)files->contentFormat,NULL,DVASPECT_CONTENT,-1,TYMED_ISTREAM},{(CLIPFORMAT)files->effectFormat,NULL,DVASPECT_CONTENT,-1,TYMED_HGLOBAL}};
  return SHCreateStdEnumFmtEtc(3,formats,result);
}
static HRESULT STDMETHODCALLTYPE advise(IDataObject* self, FORMATETC* format, DWORD flags, IAdviseSink* sink, DWORD* connection) { (void)self; (void)format; (void)flags; (void)sink; (void)connection; return OLE_E_ADVISENOTSUPPORTED; }
static HRESULT STDMETHODCALLTYPE unadvise(IDataObject* self, DWORD connection) { (void)self; (void)connection; return OLE_E_ADVISENOTSUPPORTED; }
static HRESULT STDMETHODCALLTYPE enum_advise(IDataObject* self, IEnumSTATDATA** result) { (void)self; (void)result; return OLE_E_ADVISENOTSUPPORTED; }
static IDataObjectVtbl data_vtable={query,addref,release,get_data,get_here,query_data,canonical,set_data,enumerate,advise,unadvise,enum_advise};
static VirtualFiles* async_object(IDataObjectAsyncCapability* self) { return CONTAINING_RECORD(self,VirtualFiles,async); }
static HRESULT STDMETHODCALLTYPE async_query(IDataObjectAsyncCapability* self, REFIID iid, void** result) { return query(&async_object(self)->data,iid,result); }
static ULONG STDMETHODCALLTYPE async_addref(IDataObjectAsyncCapability* self) { return addref(&async_object(self)->data); }
static ULONG STDMETHODCALLTYPE async_release(IDataObjectAsyncCapability* self) { return release(&async_object(self)->data); }
static HRESULT STDMETHODCALLTYPE set_async(IDataObjectAsyncCapability* self, BOOL value) { async_object(self)->asyncMode=value; return S_OK; }
static HRESULT STDMETHODCALLTYPE get_async(IDataObjectAsyncCapability* self, BOOL* value) { if (!value) return E_POINTER; *value=async_object(self)->asyncMode; return S_OK; }
static HRESULT STDMETHODCALLTYPE start_async(IDataObjectAsyncCapability* self, IBindCtx* context) { (void)context; async_object(self)->operation=TRUE; return S_OK; }
static HRESULT STDMETHODCALLTYPE in_async(IDataObjectAsyncCapability* self, BOOL* value) { if (!value) return E_POINTER; *value=async_object(self)->operation; return S_OK; }
static HRESULT STDMETHODCALLTYPE end_async(IDataObjectAsyncCapability* self, HRESULT result, IBindCtx* context, DWORD effects) { (void)result; (void)context; (void)effects; async_object(self)->operation=FALSE; return S_OK; }
static IDataObjectAsyncCapabilityVtbl async_vtable={async_query,async_addref,async_release,set_async,get_async,start_async,in_async,end_async};
static HRESULT STDMETHODCALLTYPE drop_query(IDropSource* self, REFIID iid, void** result) { if (!result) return E_POINTER; *result=NULL; if (!IsEqualIID(iid,&IID_IUnknown) && !IsEqualIID(iid,&IID_IDropSource)) return E_NOINTERFACE; *result=self; return S_OK; }
static ULONG STDMETHODCALLTYPE drop_ref(IDropSource* self) { (void)self; return 1; }
static HRESULT STDMETHODCALLTYPE drop_continue(IDropSource* self, BOOL escape, DWORD keys) { (void)self; return escape ? DRAGDROP_S_CANCEL : !(keys & MK_LBUTTON) ? DRAGDROP_S_DROP : S_OK; }
static HRESULT STDMETHODCALLTYPE drop_feedback(IDropSource* self, DWORD effect) { (void)self; (void)effect; return DRAGDROP_S_USEDEFAULTCURSORS; }
static IDropSourceVtbl drop_vtable={drop_query,drop_ref,drop_ref,drop_continue,drop_feedback};

int virtual_files_cli(int argc, char** argv) {
  if (argc!=2 || (strcmp(argv[1],"--virtual-clipboard") && strcmp(argv[1],"--virtual-drag") && strcmp(argv[1],"--virtual-test"))) return -1;
  BOOL testing=!strcmp(argv[1],"--virtual-test"), dragging=!strcmp(argv[1],"--virtual-drag");
  HWINSTA station=NULL, original=GetProcessWindowStation(); HDESK desktop=NULL, originalDesktop=GetThreadDesktop(GetCurrentThreadId());
  if (testing) { station=CreateWindowStationW(NULL,0,WINSTA_ALL_ACCESS,NULL); if (!station || !SetProcessWindowStation(station)) return 5; desktop=CreateDesktopW(L"OmniDeskVirtualQA",NULL,NULL,0,GENERIC_ALL,NULL); if (!desktop || !SetThreadDesktop(desktop)) return 5; }
  UINT32 length=0; BYTE* input=read_frame(&length); if (!input || length<600 || (length-8)%592 || !number(input+4) || number(input+4)>4096 || length!=8+number(input+4)*592) { free(input); return 2; }
  UINT32 sequence=number(input);
  if (FAILED(OleInitialize(NULL))) { free(input); return 3; }
  VirtualFiles* files=calloc(1,sizeof(*files)); if (!files) { free(input); OleUninitialize(); return 3; }
  files->data.lpVtbl=&data_vtable; files->async.lpVtbl=&async_vtable; files->refs=1; files->length=length-4; files->count=number(input+4);
  files->descriptors=malloc(files->length); if (!files->descriptors) { free(input); release(&files->data); OleUninitialize(); return 3; }
  memcpy(files->descriptors,input+4,files->length); free(input);
  files->descriptorFormat=RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW); files->contentFormat=RegisterClipboardFormatW(CFSTR_FILECONTENTS); files->effectFormat=RegisterClipboardFormatW(CFSTR_PREFERREDDROPEFFECT);
  for (UINT32 index=0; index<files->count; index++) { BYTE* descriptor=files->descriptors+4+index*592; if (!wmemchr((const WCHAR*)(descriptor+72),L'\0',260) || !(number(descriptor)&FD_ATTRIBUTES) || (number(descriptor+36)&FILE_ATTRIBUTE_REPARSE_POINT)) { release(&files->data); OleUninitialize(); return 2; } }
  int result=0;
  if (!dragging && !testing && GetClipboardSequenceNumber()!=sequence) result=4;
  else if (!dragging && FAILED(OleSetClipboard(&files->data))) result=3;
  UINT32 publishedSequence=GetClipboardSequenceNumber();
  if (!result && !send_message(1,publishedSequence)) result=3;
  if (!result && testing) {
    if (!OpenClipboard(NULL)) result=6;
    else { if (!GetClipboardData(files->descriptorFormat) || !GetClipboardData(files->effectFormat)) result=6; CloseClipboard(); }
    if (!result && GetClipboardSequenceNumber()!=publishedSequence) result=7;
    FORMATETC format={(CLIPFORMAT)files->descriptorFormat,NULL,DVASPECT_CONTENT,-1,TYMED_HGLOBAL}; STGMEDIUM medium;
    IDataObject* clipboard=NULL;
    if (FAILED(OleGetClipboard(&clipboard)) || FAILED(IDataObject_GetData(clipboard,&format,&medium))) result=6;
    else { ReleaseStgMedium(&medium); UINT32 triggerLength=0; BYTE* trigger=read_frame(&triggerLength); if (!trigger || triggerLength!=4 || !number(trigger)) result=6; free(trigger); }
    if (!result) { format.cfFormat=(CLIPFORMAT)files->contentFormat; format.tymed=TYMED_ISTREAM; format.lindex=0; if (FAILED(IDataObject_GetData(clipboard,&format,&medium))) result=6; else { BYTE bytes[16]; ULONG read=0; if (FAILED(IStream_Read(medium.pstm,bytes,sizeof(bytes),&read)) || !read) result=6; ReleaseStgMedium(&medium); } }
    if (!result && GetClipboardSequenceNumber()!=publishedSequence) result=7;
    if (clipboard) IDataObject_Release(clipboard);
    send_message(3,(UINT32)result);
  } else if (!result) {
    DWORD effect=0;
    if (dragging) { IDropSource source={&drop_vtable}; HRESULT dropped=(GetAsyncKeyState(VK_LBUTTON)&0x8000) ? DoDragDrop(&files->data,&source,DROPEFFECT_COPY,&effect) : DRAGDROP_S_CANCEL; if (dropped!=DRAGDROP_S_DROP) effect=0; }
    HWND timerWindow=CreateWindowExW(0,L"STATIC",L"OmniDesk virtual files",0,0,0,0,0,HWND_MESSAGE,NULL,GetModuleHandleW(NULL),NULL);
    if (!timerWindow || !SetTimer(timerWindow,1,200,NULL)) result=3;
    else {
      MSG message;
      while ((!dragging || files->operation) && GetMessageW(&message,NULL,0,0)>0) {
        if (message.message==WM_TIMER) { DWORD available=0; if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE),NULL,0,NULL,&available,NULL) || (!dragging && !files->operation && OleIsCurrentClipboard(&files->data)!=S_OK)) break; }
        TranslateMessage(&message); DispatchMessageW(&message);
      }
      KillTimer(timerWindow,1);
    }
    if (timerWindow) DestroyWindow(timerWindow);
    send_message(3,effect);
  }
  if (!dragging && OleIsCurrentClipboard(&files->data)==S_OK) OleSetClipboard(NULL);
  release(&files->data); OleUninitialize();
  if (testing) { SetThreadDesktop(originalDesktop); SetProcessWindowStation(original); if (desktop) CloseDesktop(desktop); if (station) CloseWindowStation(station); }
  return result;
}
