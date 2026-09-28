using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// .NET Framework Process.Start inherits every inheritable handle. In a redirected
// invocation this can leave extra pipe handles in detached descendants. Give the
// CLI exactly its three standard handles, retaining console/TTY behavior.
internal static class NativeChild
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal int Size;
        internal IntPtr Reserved, Desktop, Title;
        internal int X, Y, XSize, YSize, XChars, YChars, FillAttribute, Flags;
        internal short ShowWindow, ReservedSize;
        internal IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        internal StartupInfo Startup;
        internal IntPtr Attributes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process, Thread;
        internal int ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int number);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
        out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr Standard(int number, List<IntPtr> handles)
    {
        var source = GetStdHandle(number);
        if (source == IntPtr.Zero || source == new IntPtr(-1)) return IntPtr.Zero;
        IntPtr copy;
        var current = GetCurrentProcess();
        if (!DuplicateHandle(current, source, current, out copy, 0, true, 2))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inherit a standard stream.");
        handles.Add(copy);
        return copy;
    }

    internal static int Run(string application, string commandLine, string directory)
    {
        var handles = new List<IntPtr>();
        var attributes = IntPtr.Zero;
        var array = IntPtr.Zero;
        var initialized = false;
        var process = new ProcessInformation();
        try
        {
            var startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
            startup.Startup.Input = Standard(-10, handles);
            startup.Startup.Output = Standard(-11, handles);
            startup.Startup.Error = Standard(-12, handles);
            if (handles.Count == 0) throw new InvalidOperationException("No standard streams are available.");
            var size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            initialized = true;
            array = Marshal.AllocHGlobal(handles.Count * IntPtr.Size);
            for (var i = 0; i < handles.Count; i++) Marshal.WriteIntPtr(array, i * IntPtr.Size, handles[i]);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), array,
                new IntPtr(handles.Count * IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            startup.Attributes = attributes;
            // Keep the caller's environment and console/process group, including Ctrl+C.
            if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
                true, 0x80000, IntPtr.Zero, directory, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "The bundled Node runtime could not start.");
        }
        finally
        {
            // The child owns inherited duplicates. No launcher copy may keep a redirected stream open.
            foreach (var handle in handles) CloseHandle(handle);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (array != IntPtr.Zero) Marshal.FreeHGlobal(array);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
        }
        try
        {
            if (WaitForSingleObject(process.Process, 0xffffffff) != 0)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code;
            if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return unchecked((int)code);
        }
        finally { if (process.Process != IntPtr.Zero) CloseHandle(process.Process); }
    }
}
