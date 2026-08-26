#include <node_api.h>
#include <windows.h>
#include <tlhelp32.h>
#include <winternl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define PROCESS_COMMAND_LINE_INFORMATION 60
#define DEFAULT_MAX_DEPTH 32

typedef NTSTATUS(NTAPI *nt_query_information_process_fn)(
    HANDLE process,
    PROCESSINFOCLASS information_class,
    PVOID information,
    ULONG information_length,
    PULONG return_length);

typedef struct process_entry {
  DWORD pid;
  DWORD ppid;
  WCHAR executable[MAX_PATH];
} process_entry;

static void throw_windows_error(napi_env env, const char *operation) {
  DWORD code = GetLastError();
  char message[160];
  _snprintf_s(message, sizeof(message), _TRUNCATE, "%s failed with Windows error %lu", operation, code);
  napi_throw_error(env, NULL, message);
}

static char *wide_to_utf8(const WCHAR *text, int length) {
  if (text == NULL || length <= 0) return NULL;
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text, length, NULL, 0, NULL, NULL);
  if (bytes <= 0) return NULL;
  char *result = (char *)malloc((size_t)bytes + 1);
  if (result == NULL) return NULL;
  if (WideCharToMultiByte(CP_UTF8, 0, text, length, result, bytes, NULL, NULL) <= 0) {
    free(result);
    return NULL;
  }
  result[bytes] = '\0';
  return result;
}

static char *read_process_command_line(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == NULL) return NULL;

  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  nt_query_information_process_fn query = ntdll == NULL
      ? NULL
      : (nt_query_information_process_fn)GetProcAddress(ntdll, "NtQueryInformationProcess");
  if (query == NULL) {
    CloseHandle(process);
    return NULL;
  }

  ULONG required = 0;
  query(process, (PROCESSINFOCLASS)PROCESS_COMMAND_LINE_INFORMATION, NULL, 0, &required);
  if (required < sizeof(UNICODE_STRING)) {
    CloseHandle(process);
    return NULL;
  }

  ULONG capacity = required + sizeof(WCHAR);
  BYTE *buffer = (BYTE *)calloc(1, capacity);
  if (buffer == NULL) {
    CloseHandle(process);
    return NULL;
  }

  ULONG bytes_read = 0;
  NTSTATUS status = query(
      process,
      (PROCESSINFOCLASS)PROCESS_COMMAND_LINE_INFORMATION,
      buffer,
      capacity,
      &bytes_read);
  CloseHandle(process);
  if (status < 0) {
    free(buffer);
    return NULL;
  }

  if (bytes_read < sizeof(UNICODE_STRING)) {
    free(buffer);
    return NULL;
  }
  UNICODE_STRING *command_line = (UNICODE_STRING *)buffer;
  BYTE *text_start = (BYTE *)command_line->Buffer;
  BYTE *buffer_end = buffer + capacity;
  if (text_start < buffer + sizeof(UNICODE_STRING) || text_start > buffer_end || command_line->Length > (ULONG)(buffer_end - text_start)) {
    free(buffer);
    return NULL;
  }
  char *result = wide_to_utf8(command_line->Buffer, command_line->Length / sizeof(WCHAR));
  free(buffer);
  return result;
}

static process_entry *snapshot_processes(size_t *count) {
  *count = 0;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return NULL;

  size_t capacity = 256;
  process_entry *entries = (process_entry *)malloc(capacity * sizeof(process_entry));
  if (entries == NULL) {
    CloseHandle(snapshot);
    return NULL;
  }

  PROCESSENTRY32W current;
  ZeroMemory(&current, sizeof(current));
  current.dwSize = sizeof(current);
  if (!Process32FirstW(snapshot, &current)) {
    free(entries);
    CloseHandle(snapshot);
    return NULL;
  }

  do {
    if (*count == capacity) {
      capacity *= 2;
      process_entry *grown = (process_entry *)realloc(entries, capacity * sizeof(process_entry));
      if (grown == NULL) {
        free(entries);
        CloseHandle(snapshot);
        return NULL;
      }
      entries = grown;
    }
    entries[*count].pid = current.th32ProcessID;
    entries[*count].ppid = current.th32ParentProcessID;
    wcsncpy_s(entries[*count].executable, MAX_PATH, current.szExeFile, _TRUNCATE);
    (*count)++;
  } while (Process32NextW(snapshot, &current));

  CloseHandle(snapshot);
  return entries;
}

static const process_entry *find_process(const process_entry *entries, size_t count, DWORD pid) {
  for (size_t index = 0; index < count; index++) {
    if (entries[index].pid == pid) return &entries[index];
  }
  return NULL;
}

static napi_value get_process_ancestry(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "startPid is required");
    return NULL;
  }

  uint32_t start_pid = 0;
  if (napi_get_value_uint32(env, argv[0], &start_pid) != napi_ok || start_pid == 0) {
    napi_throw_range_error(env, NULL, "startPid must be a positive integer");
    return NULL;
  }

  uint32_t max_depth = DEFAULT_MAX_DEPTH;
  if (argc >= 2 && napi_get_value_uint32(env, argv[1], &max_depth) != napi_ok) {
    napi_throw_type_error(env, NULL, "maxDepth must be an integer");
    return NULL;
  }
  if (max_depth == 0 || max_depth > 128) {
    napi_throw_range_error(env, NULL, "maxDepth must be between 1 and 128");
    return NULL;
  }

  size_t count = 0;
  process_entry *entries = snapshot_processes(&count);
  if (entries == NULL) {
    throw_windows_error(env, "CreateToolhelp32Snapshot");
    return NULL;
  }

  napi_value result;
  napi_create_array(env, &result);
  DWORD pid = start_pid;
  uint32_t output_index = 0;
  for (uint32_t depth = 0; depth < max_depth && pid > 0; depth++) {
    const process_entry *entry = find_process(entries, count, pid);
    if (entry == NULL) break;

    napi_value item;
    napi_value value;
    napi_create_object(env, &item);
    napi_create_uint32(env, entry->pid, &value);
    napi_set_named_property(env, item, "pid", value);
    napi_create_uint32(env, entry->ppid, &value);
    napi_set_named_property(env, item, "ppid", value);

    char *executable = wide_to_utf8(entry->executable, (int)wcslen(entry->executable));
    if (executable != NULL) {
      napi_create_string_utf8(env, executable, NAPI_AUTO_LENGTH, &value);
      free(executable);
    } else {
      napi_get_null(env, &value);
    }
    napi_set_named_property(env, item, "executable", value);

    char *command_line = read_process_command_line(entry->pid);
    if (command_line != NULL) {
      napi_create_string_utf8(env, command_line, NAPI_AUTO_LENGTH, &value);
      free(command_line);
    } else {
      napi_get_null(env, &value);
    }
    napi_set_named_property(env, item, "commandLine", value);
    napi_set_element(env, result, output_index++, item);

    if (entry->ppid == pid) break;
    pid = entry->ppid;
  }

  free(entries);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "getProcessAncestry", NAPI_AUTO_LENGTH, get_process_ancestry, NULL, &function);
  napi_set_named_property(env, exports, "getProcessAncestry", function);
  return exports;
}
