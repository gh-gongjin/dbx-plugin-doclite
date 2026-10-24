using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class Program
{
    private static int Main()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string pluginRoot = Path.GetFullPath(Path.Combine(baseDir, "..", ".."));
        string node = Path.Combine(pluginRoot, "backend", "vendor", "node", "node.exe");
        if (!File.Exists(node)) node = "node.exe";

        string script = Path.Combine(pluginRoot, "backend", "sidecar.cjs");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("[doclite] sidecar script not found: " + script);
            return 2;
        }

        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = node;
        info.Arguments = "\"" + script + "\"";
        info.WorkingDirectory = pluginRoot;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;

        Process child;
        try
        {
            child = Process.Start(info);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[doclite] cannot start converter runtime: " + error.Message);
            return 127;
        }
        if (child == null)
        {
            Console.Error.WriteLine("[doclite] cannot start converter runtime.");
            return 127;
        }

        StartPump(delegate { PumpInput(child); });
        Thread output = StartPump(delegate { Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); });
        Thread errors = StartPump(delegate { Pump(child.StandardError.BaseStream, Console.OpenStandardError()); });

        child.WaitForExit();
        output.Join(2000);
        errors.Join(2000);

        int code = child.ExitCode;
        try { child.Dispose(); } catch { }
        return code;
    }

    private static Thread StartPump(ThreadStart body)
    {
        Thread thread = new Thread(body);
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static void PumpInput(Process child)
    {
        try
        {
            Stream input = Console.OpenStandardInput();
            byte[] buffer = new byte[65536];
            while (true)
            {
                int read = input.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                child.StandardInput.BaseStream.Write(buffer, 0, read);
                child.StandardInput.BaseStream.Flush();
            }
        }
        catch
        {
            /* host closed the pipe */
        }
        finally
        {
            try { child.StandardInput.Close(); } catch { }
        }
    }

    private static void Pump(Stream from, Stream to)
    {
        try
        {
            byte[] buffer = new byte[65536];
            while (true)
            {
                int read = from.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                to.Write(buffer, 0, read);
                to.Flush();
            }
        }
        catch
        {
            /* the other side went away; the host handles the exit code */
        }
    }
}
