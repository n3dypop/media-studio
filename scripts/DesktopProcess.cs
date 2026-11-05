// Windows GUI process creation with a private environment block. The token is
// not included in the command line and no parent handles are inherited.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class MediaStudioDesktopProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2; public IntPtr reserved2Ptr, stdInput, stdOutput, stdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public int processId, threadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    static string Quote(string text) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in text) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static int Start(string executable, string cwd, string token, string runtimeHome, string desktopHome) {
        if (String.IsNullOrWhiteSpace(executable) || String.IsNullOrWhiteSpace(cwd) ||
            String.IsNullOrWhiteSpace(token) || String.IsNullOrWhiteSpace(runtimeHome) ||
            String.IsNullOrWhiteSpace(desktopHome)) throw new ArgumentException("Invalid process configuration.");
        var env = new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry item in Environment.GetEnvironmentVariables()) {
            string key = item.Key as string, value = item.Value as string;
            if (key == null || value == null || key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0) continue;
            env[key] = value;
        }
        env.Remove("ELECTRON_RUN_AS_NODE");
        env["LOCAL_GENAI_DSH_TOKEN"] = token;
        env["MEDIA_STUDIO_HOME"] = runtimeHome;
        env["DSH_HOME"] = desktopHome;
        var entries = new List<string>();
        foreach (var item in env) entries.Add(item.Key + "=" + item.Value);
        string block = String.Join("\0", entries) + "\0\0";
        IntPtr memory = Marshal.StringToHGlobalUni(block);
        try {
            var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            ProcessInfo result;
            if (!CreateProcess(executable, new StringBuilder(Quote(executable)), IntPtr.Zero, IntPtr.Zero,
                    false, 0x00000400, memory, cwd, ref startup, out result))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Desktop process creation failed.");
            CloseHandle(result.thread); CloseHandle(result.process);
            return result.processId;
        } finally {
            for (int i = 0; i < block.Length; i++) Marshal.WriteInt16(memory, i * 2, 0);
            Marshal.FreeHGlobal(memory);
        }
    }
}
