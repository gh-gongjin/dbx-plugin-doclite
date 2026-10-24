using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// Native folder picker for the DocLite plugin. The DBX host exposes no
// directory-selection API, so the sidecar spawns this helper and reads the
// chosen path from the result file it writes.
internal static class Picker
{
    private const int GwlHwndParent = -8;
    private const int SwShow = 5;
    private static string _dialogTitle = "选择保存目录";

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool SetWindowText(IntPtr hWnd, string text);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowLong(IntPtr hWnd, int index, IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static int Main(string[] args)
    {
        string resultFile = null;
        string initial = null;
        string autoSelect = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--result" && i + 1 < args.Length) resultFile = args[++i];
            else if (args[i] == "--initial" && i + 1 < args.Length) initial = args[++i];
            else if (args[i] == "--auto-select" && i + 1 < args.Length) autoSelect = args[++i];
            else if (args[i] == "--title" && i + 1 < args.Length && args[i + 1].Trim().Length > 0) _dialogTitle = args[++i];
        }
        if (string.IsNullOrEmpty(resultFile)) return 2;

        try
        {
            string payload;
            if (!string.IsNullOrEmpty(autoSelect))
            {
                payload = "{\"ok\":true,\"path\":" + JsonString(autoSelect) + "}";
            }
            else
            {
                string picked = PickFolder(initial);
                payload = picked == null
                    ? "{\"ok\":false,\"canceled\":true}"
                    : "{\"ok\":true,\"path\":" + JsonString(picked) + "}";
            }
            WriteResult(resultFile, payload);
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                WriteResult(resultFile, "{\"ok\":false,\"error\":" + JsonString(error.Message) + "}");
            }
            catch
            {
                /* nothing else to do */
            }
            return 1;
        }
    }

    private static void WriteResult(string resultFile, string payload)
    {
        string directory = Path.GetDirectoryName(resultFile);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string temporary = resultFile + ".tmp";
        File.WriteAllText(temporary, payload, new UTF8Encoding(false));
        if (File.Exists(resultFile)) File.Delete(resultFile);
        File.Move(temporary, resultFile);
    }

    private static string PickFolder(string initial)
    {
        string picked = null;
        Exception failure = null;
        Thread thread = new Thread(delegate()
        {
            try
            {
                picked = RunDialog(initial);
            }
            catch (Exception error)
            {
                failure = error;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure != null) throw failure;
        return picked;
    }

    private static string RunDialog(string initial)
    {
        IntPtr owner = ResolveOwnerWindow();
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        using (Activator activator = new Activator(owner))
        {
            dialog.Description = _dialogTitle;
            dialog.ShowNewFolderButton = true;
            if (!string.IsNullOrEmpty(initial))
            {
                try
                {
                    if (Directory.Exists(initial)) dialog.SelectedPath = initial;
                }
                catch
                {
                    /* an unusable initial path just leaves the tree at the root */
                }
            }
            activator.Start();
            try
            {
                DialogResult result;
                if (owner != IntPtr.Zero) result = dialog.ShowDialog(new OwnerWindow(owner));
                else result = dialog.ShowDialog();
                return result == DialogResult.OK ? dialog.SelectedPath : null;
            }
            finally
            {
                activator.Stop();
            }
        }
    }

    /// The DBX window is the one hosting the plugin, so it owns the dialog and
    /// keeps it above the app instead of behind it.
    private static IntPtr ResolveOwnerWindow()
    {
        IntPtr foreground = GetForegroundWindow();
        if (foreground != IntPtr.Zero && IsWindowVisible(foreground)) return foreground;
        IntPtr found = IntPtr.Zero;
        uint self = (uint)Process.GetCurrentProcess().Id;
        EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (found != IntPtr.Zero) return false;
            if (!IsWindowVisible(hWnd)) return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId == self) return true;
            found = hWnd;
            return false;
        };
        EnumWindows(callback, IntPtr.Zero);
        return found;
    }

    private static IntPtr FindDialogWindow()
    {
        IntPtr found = IntPtr.Zero;
        uint self = (uint)Process.GetCurrentProcess().Id;
        EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (found != IntPtr.Zero) return false;
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder className = new StringBuilder(64);
            GetClassName(hWnd, className, className.Capacity);
            if (className.ToString() != "#32770") return true;
            uint processId;
            GetWindowThreadProcessId(hWnd, out processId);
            if (processId != self) return true;
            found = hWnd;
            return false;
        };
        EnumWindows(callback, IntPtr.Zero);
        return found;
    }

    private static void ForceForeground(IntPtr dialog)
    {
        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = 0;
        if (foreground != IntPtr.Zero)
        {
            uint processId;
            foregroundThread = GetWindowThreadProcessId(foreground, out processId);
        }
        uint selfThread = GetCurrentThreadId();
        bool attached = false;
        if (foregroundThread != 0 && foregroundThread != selfThread)
        {
            attached = AttachThreadInput(selfThread, foregroundThread, true);
        }
        try
        {
            SetForegroundWindow(dialog);
            BringWindowToTop(dialog);
        }
        finally
        {
            if (attached) AttachThreadInput(selfThread, foregroundThread, false);
        }
    }

    private static string JsonString(string value)
    {
        StringBuilder text = new StringBuilder(value.Length + 8);
        text.Append('"');
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '"' || c == '\\') text.Append('\\').Append(c);
            else if (c == '\n') text.Append("\\n");
            else if (c == '\r') text.Append("\\r");
            else if (c == '\t') text.Append("\\t");
            else if (c < 0x20) text.Append("\\u").Append(((int)c).ToString("x4"));
            else text.Append(c);
        }
        text.Append('"');
        return text.ToString();
    }

    private sealed class OwnerWindow : IWin32Window
    {
        private readonly IntPtr _handle;

        public OwnerWindow(IntPtr handle)
        {
            _handle = handle;
        }

        public IntPtr Handle
        {
            get { return _handle; }
        }
    }

    /// Keeps the dialog owned by (and above) the host window until it takes
    /// focus. Once the user moves to another app the dialog is left alone.
    private sealed class Activator : IDisposable
    {
        private readonly IntPtr _owner;
        private readonly Thread _thread;
        private volatile bool _running = true;
        private bool _activated;

        public Activator(IntPtr owner)
        {
            _owner = owner;
            _thread = new Thread(Run);
            _thread.IsBackground = true;
        }

        public void Start()
        {
            _thread.Start();
        }

        public void Stop()
        {
            _running = false;
        }

        public void Dispose()
        {
            Stop();
        }

        private void Run()
        {
            bool titled = false;
            while (_running)
            {
                IntPtr dialog = FindDialogWindow();
                if (dialog != IntPtr.Zero)
                {
                    if (!titled)
                    {
                        SetWindowText(dialog, _dialogTitle);
                        titled = true;
                    }
                    IntPtr foreground = GetForegroundWindow();
                    if (foreground == dialog) _activated = true;
                    if (!_activated || foreground == _owner)
                    {
                        if (_owner != IntPtr.Zero) SetWindowLong(dialog, GwlHwndParent, _owner);
                        ShowWindow(dialog, SwShow);
                        BringWindowToTop(dialog);
                        ForceForeground(dialog);
                    }
                }
                Thread.Sleep(120);
            }
        }
    }
}
