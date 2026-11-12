using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using MSTSCLib;

sealed class RdpControl : AxHost {
    public RdpControl() : base("A0C63C30-F08D-4AB4-907C-34905D770C7D") { }
    public object Client { get { return GetOcx(); } }
}

sealed class RdpHost : Form {
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr window, IntPtr after, int left, int top, int width, int height, uint flags);

    readonly RdpControl control = new RdpControl();
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    dynamic client;
    IMsTscAxEvents_Event events;
    bool connected;
    bool desiredVisible;
    bool closing;
    bool dynamicResolution;
    int desktopWidth;
    int desktopHeight;

    public RdpHost() {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        AutoScaleMode = AutoScaleMode.None;
        ((ISupportInitialize)control).BeginInit();
        Controls.Add(control);
        control.Dock = DockStyle.Fill;
        ((ISupportInitialize)control).EndInit();
    }

    public void Initialize(Dictionary<string, object> config, bool selfTest) {
        IntPtr window = Handle;
        control.CreateControl();
        client = control.Client;
        if (selfTest) {
            Emit("self-test", "", 0);
            return;
        }

        IntPtr parent = new IntPtr(long.Parse(Text(config, "parent"), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
        uint owner;
        if (GetWindowThreadProcessId(parent, out owner) == 0 || owner != Number(config, "ownerPid")) {
            throw new InvalidOperationException("Invalid owner window");
        }
        SetParent(window, parent);
        if (Marshal.GetLastWin32Error() != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        long style = GetWindowLongPtr(window, -16).ToInt64();
        SetWindowLongPtr(window, -16, new IntPtr((style & ~0x80000000L) | 0x40000000L | 0x04000000L));

        client.Server = Text(config, "host");
        client.UserName = Text(config, "username");
        client.Domain = Text(config, "domain");
        desktopWidth = Number(config, "desktopWidth");
        desktopHeight = Number(config, "desktopHeight");
        client.DesktopWidth = desktopWidth;
        client.DesktopHeight = desktopHeight;
        client.ColorDepth = Number(config, "colorDepth");
        dynamic advanced = client.AdvancedSettings7;
        advanced.RDPPort = Number(config, "port");
        advanced.SmartSizing = true;
        advanced.EnableAutoReconnect = false;
        advanced.AuthenticationLevel = 0;
        advanced.EnableCredSspSupport = false;
        advanced.RedirectClipboard = Flag(config, "clipboard");
        advanced.RedirectDrives = false;
        advanced.RedirectPrinters = false;
        advanced.RedirectPorts = false;
        advanced.RedirectSmartCards = false;
        advanced.PerformanceFlags = Number(config, "performanceFlags");
        client.SecuredSettings2.AudioRedirectionMode = Number(config, "audioMode");
        dynamicResolution = Flag(config, "dynamicResolution");
        IMsRdpClientNonScriptable5 settings = (IMsRdpClientNonScriptable5)control.Client;
        settings.EnableCredSspSupport = false;
        settings.PromptForCredentials = false;
        settings.PromptForCredsOnClient = false;
        settings.AllowCredentialSaving = false;
        settings.WarnAboutSendingCredentials = false;
        settings.ShowRedirectionWarningDialog = false;
        settings.RedirectDynamicDrives = false;
        settings.RedirectDynamicDevices = false;
        settings.ClearTextPassword = Text(config, "password");
        config["password"] = null;
        events = (IMsTscAxEvents_Event)control.Client;
        events.OnConnected += OnConnected;
        events.OnDisconnected += OnDisconnected;
        events.OnFatalError += OnFatalError;
        UpdateLayout(config);
        Emit("ready", "", 0);
        client.Connect();
    }

    public void UpdateLayout(Dictionary<string, object> config) {
        if (closing) return;
        desiredVisible = Flag(config, "visible");
        if (!SetWindowPos(Handle, IntPtr.Zero, Number(config, "x"), Number(config, "y"),
            Math.Max(1, Number(config, "width")), Math.Max(1, Number(config, "height")), 0x0010 | 0x0020)) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        Visible = connected && desiredVisible;
        int nextWidth = Number(config, "desktopWidth");
        int nextHeight = Number(config, "desktopHeight");
        if (!connected || !desiredVisible || !dynamicResolution || nextWidth == desktopWidth && nextHeight == desktopHeight) return;
        try {
            client.UpdateSessionDisplaySettings((uint)nextWidth, (uint)nextHeight,
                (uint)Math.Max(10, nextWidth * 254 / 960), (uint)Math.Max(10, nextHeight * 254 / 960), 0u, 100u, 100u);
            desktopWidth = nextWidth;
            desktopHeight = nextHeight;
        } catch (COMException) { }
    }

    public void Dispatch(Dictionary<string, object> command) {
        if (closing) return;
        string operation = Text(command, "command");
        if (operation == "layout") UpdateLayout(command);
        else if (operation == "stop") Close();
        else if (operation == "focus" && connected && desiredVisible) control.Focus();
    }

    void OnConnected() {
        connected = true;
        Visible = desiredVisible;
        Emit("connected", "", 0);
    }

    void OnDisconnected(int reason) {
        connected = false;
        Hide();
        if (closing) return;
        string message;
        try { message = client.GetErrorDescription((uint)reason, (uint)client.ExtendedDisconnectReason); }
        catch { message = "Windows RDP session disconnected"; }
        Emit(reason == 1 ? "ended" : "error", message, reason);
    }

    void OnFatalError(int reason) {
        connected = false;
        Hide();
        Emit("error", "Windows RDP component error", reason);
    }

    protected override void OnFormClosing(FormClosingEventArgs args) {
        closing = true;
        try { if (client != null && client.Connected != 0) client.Disconnect(); } catch (COMException) { }
        base.OnFormClosing(args);
    }

    public void Emit(string phase, string message, int code) {
        lock (Console.Out) {
            Console.WriteLine(json.Serialize(new { phase = phase, message = message, code = code }));
            Console.Out.Flush();
        }
    }

    static string Text(Dictionary<string, object> data, string name) {
        object value;
        return data.TryGetValue(name, out value) && value != null ? Convert.ToString(value, CultureInfo.InvariantCulture) : "";
    }

    static int Number(Dictionary<string, object> data, string name) { return Convert.ToInt32(data[name], CultureInfo.InvariantCulture); }
    static bool Flag(Dictionary<string, object> data, string name) { return data.ContainsKey(name) && Convert.ToBoolean(data[name], CultureInfo.InvariantCulture); }
}

static class Program {
    [STAThread]
    static int Main(string[] arguments) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try {
            using (RdpHost host = new RdpHost()) {
                if (arguments.Length == 1 && arguments[0] == "--self-test") {
                    host.Initialize(new Dictionary<string, object>(), true);
                    return 0;
                }
                JavaScriptSerializer json = new JavaScriptSerializer();
                string initial = Console.ReadLine();
                if (initial == null || initial.Length > 65536) return 1;
                Dictionary<string, object> config = json.Deserialize<Dictionary<string, object>>(initial);
                host.Initialize(config, false);
                Thread input = new Thread(() => {
                    try {
                        string line;
                        while ((line = Console.ReadLine()) != null) {
                            if (line.Length > 65536) break;
                            Dictionary<string, object> command = json.Deserialize<Dictionary<string, object>>(line);
                            host.BeginInvoke(new Action(() => {
                                try { host.Dispatch(command); }
                                catch { host.Emit("error", "Native RDP layout or command failed", 0); host.Close(); }
                            }));
                        }
                    } catch { }
                    Environment.Exit(0);
                });
                input.IsBackground = true;
                input.Start();
                Application.Run();
            }
            return 0;
        } catch {
            Console.WriteLine("{\"phase\":\"error\",\"message\":\"Windows RDP component could not initialize\",\"code\":0}");
            return 1;
        }
    }
}
