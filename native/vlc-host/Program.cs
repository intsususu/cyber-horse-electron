using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// 播放器在独立进程运行；仅接受主进程管道中的固定命令，不启动 VLC 桌面界面。
internal static class Program
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static IntPtr instance, player;
    private static Surface surface;
    private static string token = "";
    private static bool muted = true;
    private static int volume = 100;
    private static double startSeconds;
    private static bool positioned;
    private static bool audioApplied;
    private static readonly object OutputLock = new object();

    [STAThread]
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length != 2 || !Path.IsPathRooted(args[0])) return 2;
            var parent = new IntPtr(long.Parse(args[1]));
            if (!Native.IsWindow(parent)) return 2;
            // 显式 DLL 路径和搜索目录，避免从媒体目录或当前目录加载依赖。
            Native.SetDefaultDllDirectories(0x1000);
            Native.AddDllDirectory(args[0]);
            if (Native.LoadLibraryEx(Path.Combine(args[0], "libvlc.dll"), IntPtr.Zero, 0x1100) == IntPtr.Zero)
                throw new Exception("无法加载 64 位 VLC 播放引擎。请检查 VLC 安装。 ");
            if (!Utf8(Native.libvlc_get_version()).StartsWith("3."))
                throw new Exception("当前内嵌播放支持 VLC 3.x 64 位版本。 ");
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            Application.EnableVisualStyles();
            surface = new Surface(parent);
            var handle = surface.Handle;
            var options = new[] { "--quiet", "--no-video-title-show", "--no-osd", "--no-sub-autodetect-file", "--no-metadata-network-access", "--intf=dummy" };
            var pointers = new IntPtr[options.Length];
            var array = Marshal.AllocHGlobal(IntPtr.Size * options.Length);
            try
            {
                for (int i = 0; i < options.Length; i++)
                {
                    pointers[i] = Marshal.StringToHGlobalAnsi(options[i]);
                    Marshal.WriteIntPtr(array, i * IntPtr.Size, pointers[i]);
                }
                instance = Native.libvlc_new(options.Length, array);
            }
            finally
            {
                foreach (var pointer in pointers) Marshal.FreeHGlobal(pointer);
                Marshal.FreeHGlobal(array);
            }
            if (instance == IntPtr.Zero) throw new Exception("VLC 播放引擎初始化失败。 ");
            player = Native.libvlc_media_player_new(instance);
            if (player == IntPtr.Zero) throw new Exception("无法创建 VLC 播放会话。 ");
            Native.libvlc_media_player_set_hwnd(player, handle);
            Native.libvlc_video_set_key_input(player, 0);
            Native.libvlc_video_set_mouse_input(player, 0);
            var timer = new System.Windows.Forms.Timer { Interval = 250 };
            timer.Tick += delegate
            {
                if (!Native.IsWindow(parent)) { Application.ExitThread(); return; }
                if (token.Length > 0)
                {
                    // Chromium 在窗口激活和尺寸变化时会提升自己的子窗口，需要恢复视频兄弟窗口的层级。
                    surface.UpdatePlacement();
                    State();
                }
            };
            timer.Start();
            var reader = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        if (line.Length > 65536) break;
                        var command = Json.Deserialize<Dictionary<string, object>>(line);
                        surface.BeginInvoke(new Action(delegate { Command(command); }));
                    }
                }
                catch { }
                try { surface.BeginInvoke(new Action(Application.ExitThread)); } catch { }
            }) { IsBackground = true };
            reader.Start();
            Send(new { type = "ready" });
            Application.Run();
            timer.Stop();
            timer.Dispose();
            return 0;
        }
        catch (Exception)
        {
            Send(new { type = "error", message = "VLC 内嵌播放失败，请检查 64 位 VLC 3.x 安装或切回默认播放器。" });
            return 1;
        }
        finally
        {
            if (player != IntPtr.Zero) { Native.libvlc_media_player_stop(player); Native.libvlc_media_player_release(player); }
            if (instance != IntPtr.Zero) Native.libvlc_release(instance);
            if (surface != null) surface.Dispose();
        }
    }

    private static void Command(Dictionary<string, object> c)
    {
        try
        {
            var action = (string)c["action"];
            if (action == "close") { Native.ShowWindow(surface.Handle, 0); Application.ExitThread(); return; }
            if (action == "open")
            {
                token = (string)c["token"];
                muted = (bool)c["muted"];
                startSeconds = Convert.ToDouble(c["startSeconds"]);
                var url = (string)c["url"];
                var uri = new Uri(url);
                if (uri.Scheme != "http" || uri.Host != "127.0.0.1") throw new Exception();
                var media = Native.libvlc_media_new_location(instance, url);
                if (media == IntPtr.Zero) throw new Exception();
                try
                {
                    Native.libvlc_media_add_option(media, ":network-caching=600");
                    Native.libvlc_media_add_option(media, ":start-time=" + startSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    Native.libvlc_media_player_set_media(player, media);
                }
                finally { Native.libvlc_media_release(media); }
                Native.libvlc_audio_set_volume(player, muted ? 0 : volume);
                Native.libvlc_audio_set_mute(player, muted ? 1 : 0);
                Bounds((Dictionary<string, object>)c["bounds"]);
                if (Native.libvlc_media_player_play(player) != 0) throw new Exception();
                State();
            }
            else if (action == "bounds") Bounds((Dictionary<string, object>)c["bounds"]);
            else if (action == "pause")
            {
                if (Native.libvlc_media_player_get_state(player) == 6 && !(bool)c["paused"])
                {
                    Native.libvlc_media_player_play(player);
                    Native.libvlc_media_player_set_time(player, 0);
                }
                else Native.libvlc_media_player_set_pause(player, (bool)c["paused"] ? 1 : 0);
            }
            else if (action == "seek") Native.libvlc_media_player_set_time(player, (long)(Convert.ToDouble(c["seconds"]) * 1000));
            else if (action == "audio")
            {
                muted = (bool)c["muted"];
                volume = (int)Math.Round(Convert.ToDouble(c["volume"]) * 100);
                Native.libvlc_audio_set_volume(player, muted ? 0 : volume);
                Native.libvlc_audio_set_mute(player, muted ? 1 : 0);
            }
            else if (action == "subtitle") Native.libvlc_video_set_spu(player, c["index"] == null ? -1 : Convert.ToInt32(c["index"]));
            else if (action == "subtitle-url")
            {
                var uri = new Uri((string)c["url"]);
                if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || Native.libvlc_media_player_add_slave(player, 0, uri.AbsoluteUri, true) != 0)
                    throw new Exception();
            }
        }
        catch { Send(new { type = "error", message = "VLC 无法执行播放操作，请重新打开视频。" }); }
    }

    private static void Bounds(Dictionary<string, object> b)
    {
        surface.Place(b);
    }

    private static void State()
    {
        var state = Native.libvlc_media_player_get_state(player);
        uint width, height;
        Native.libvlc_video_get_size(player, 0, out width, out height);
        if (state == 3 && !positioned)
        {
            positioned = true;
            if (startSeconds > 0) Native.libvlc_media_player_set_time(player, (long)(startSeconds * 1000));
        }
        if (state == 3 && !audioApplied)
        {
            audioApplied = true;
            Native.libvlc_audio_set_volume(player, muted ? 0 : volume);
            Native.libvlc_audio_set_mute(player, muted ? 1 : 0);
        }
        var tracks = new List<object>();
        var head = Native.libvlc_video_get_spu_description(player);
        try
        {
            var cursor = head;
            while (cursor != IntPtr.Zero && tracks.Count < 256)
            {
                var track = (Track)Marshal.PtrToStructure(cursor, typeof(Track));
                if (track.id >= 0) tracks.Add(new { index = track.id, name = Utf8(track.name), language = "", codec = "vlc", isText = true });
                cursor = track.next;
            }
        }
        finally { if (head != IntPtr.Zero) Native.libvlc_track_description_list_release(head); }
        var length = Native.libvlc_media_player_get_length(player);
        var subtitle = Native.libvlc_video_get_spu(player);
        Native.Rect rect;
        Native.GetWindowRect(surface.Handle, out rect);
        Send(new { type = "state", state = new {
            token, status = state == 7 ? "failed" : state == 6 ? "ended" : state == 4 ? "paused" : state == 3 ? "playing" : "loading",
            position = Math.Max(0, Native.libvlc_media_player_get_time(player) / 1000.0),
            duration = length > 0 ? (double?)(length / 1000.0) : null,
            width, height, surfaceVisible = Native.IsWindowVisible(surface.Handle), embedded = surface.Embedded, surfaceOnTop = surface.OnTop,
            surfaceBounds = new { x = rect.left, y = rect.top, width = rect.right - rect.left, height = rect.bottom - rect.top },
            volume = volume / 100.0, muted, subtitles = tracks,
            subtitleIndex = subtitle < 0 ? (int?)null : subtitle,
            message = state == 7 ? "VLC 视频解码失败，请检查媒体或重新打开。" : ""
        }});
    }

    private static string Utf8(IntPtr p)
    {
        if (p == IntPtr.Zero) return "";
        var bytes = new List<byte>();
        for (int i = 0; i < 4096; i++) { byte b = Marshal.ReadByte(p, i); if (b == 0) break; bytes.Add(b); }
        return Encoding.UTF8.GetString(bytes.ToArray());
    }
    private static void Send(object value)
    {
        lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Track { public int id; public IntPtr name; public IntPtr next; }
    private sealed class Surface : Control
    {
        private readonly IntPtr parent;
        private int x, y, width = 1, height = 1;
        private bool shown;
        public Surface(IntPtr parent) { this.parent = parent; BackColor = Color.Black; }
        public bool Embedded { get { return Native.GetParent(Handle) == parent; } }
        public bool OnTop { get { return Native.GetTopWindow(parent) == Handle; } }
        public void Place(Dictionary<string, object> b)
        {
            x = Convert.ToInt32(b["x"]); y = Convert.ToInt32(b["y"]);
            width = Math.Max(1, Convert.ToInt32(b["width"])); height = Math.Max(1, Convert.ToInt32(b["height"]));
            shown = (bool)b["visible"] && Convert.ToDouble(b["width"]) > 0 && Convert.ToDouble(b["height"]) > 0;
            UpdatePlacement();
        }
        public void UpdatePlacement()
        {
            var visible = shown && Native.IsWindowVisible(parent) && !Native.IsIconic(parent);
            // 父窗口属于 Electron 进程，直接维护原生位置、显示状态和兄弟窗口层级。
            Native.SetWindowPos(Handle, IntPtr.Zero, x, y, width, height, visible ? 0x50u : 0x90u);
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x21 || message.Msg == 0x201 || (message.Msg == 0x210 && (message.WParam.ToInt64() & 0xffff) == 0x201))
                Send(new { type = "input", key = "focus" });
            if (message.Msg == 0x203) Send(new { type = "input", key = "Enter" });
            base.WndProc(ref message);
        }
        protected override bool ProcessCmdKey(ref Message message, Keys key)
        {
            if (key == Keys.Space || key == Keys.Enter || key == Keys.Escape || key == Keys.Left || key == Keys.Right)
            {
                Send(new { type = "input", key = key.ToString() });
                return true;
            }
            return base.ProcessCmdKey(ref message, key);
        }
        protected override CreateParams CreateParams
        {
            get { var p = base.CreateParams; p.Parent = parent; p.Style = 0x46000000; p.Width = 1; p.Height = 1; return p; }
        }
    }

    private static class Native
    {
        [DllImport("kernel32.dll")] public static extern bool SetDefaultDllDirectories(uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr AddDllDirectory(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
        [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr window);
        [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr libvlc_get_version();
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr libvlc_new(int count, IntPtr args);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_release(IntPtr instance);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr libvlc_media_player_new(IntPtr instance);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_player_release(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr libvlc_media_new_location(IntPtr instance, [MarshalAs(UnmanagedType.LPUTF8Str)] string url);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_add_option(IntPtr media, [MarshalAs(UnmanagedType.LPUTF8Str)] string option);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_release(IntPtr media);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_player_set_media(IntPtr player, IntPtr media);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_player_set_hwnd(IntPtr player, IntPtr window);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int libvlc_media_player_play(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_player_stop(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_player_set_pause(IntPtr player, int pause);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int libvlc_media_player_get_state(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern long libvlc_media_player_get_time(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern long libvlc_media_player_get_length(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_media_player_set_time(IntPtr player, long time);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int libvlc_video_get_size(IntPtr player, uint index, out uint width, out uint height);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_video_set_key_input(IntPtr player, uint enabled);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_video_set_mouse_input(IntPtr player, uint enabled);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_audio_set_mute(IntPtr player, int mute);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int libvlc_audio_set_volume(IntPtr player, int volume);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr libvlc_video_get_spu_description(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void libvlc_track_description_list_release(IntPtr list);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int libvlc_video_get_spu(IntPtr player);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int libvlc_video_set_spu(IntPtr player, int index);
        [DllImport("libvlc.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int libvlc_media_player_add_slave(IntPtr player, int type, [MarshalAs(UnmanagedType.LPUTF8Str)] string uri, [MarshalAs(UnmanagedType.I1)] bool select);
    }
}
