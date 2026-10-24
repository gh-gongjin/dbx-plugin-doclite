using System;
using System.IO;
using System.Threading;

// Test double for the native folder picker. The sidecar reads the chosen path
// from the result file, so the double only has to produce that file instead of
// showing a native dialog. FAKE_PICKER_MODE_FILE selects the behaviour:
// "ok" (default) picks a path, "cancel" reports no selection, "die" exits
// without a result, "hang" never returns. "ok|<dir>" picks that directory.
internal static class FakePicker
{
    private static int Main(string[] args)
    {
        string resultFile = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--result" && i + 1 < args.Length) resultFile = args[++i];
        }
        if (string.IsNullOrEmpty(resultFile)) return 2;

        string mode = "ok";
        string picked = "D:\\fake\\picked";
        string modeFile = Environment.GetEnvironmentVariable("FAKE_PICKER_MODE_FILE");
        if (!string.IsNullOrEmpty(modeFile) && File.Exists(modeFile))
        {
            mode = File.ReadAllText(modeFile).Trim();
        }
        int separator = mode.IndexOf('|');
        if (separator >= 0)
        {
            picked = mode.Substring(separator + 1);
            mode = mode.Substring(0, separator);
        }

        if (mode == "hang")
        {
            Thread.Sleep(600000);
            return 0;
        }
        if (mode == "die") return 3;

        string payload = mode == "cancel"
            ? "{\"ok\":false,\"canceled\":true}"
            : "{\"ok\":true,\"path\":\"" + picked.Replace("\\", "\\\\") + "\"}";
        File.WriteAllText(resultFile, payload);
        return 0;
    }
}
