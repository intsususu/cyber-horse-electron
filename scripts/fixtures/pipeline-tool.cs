using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// 仅用于隔离桌面测试的可执行工具替身，不读取真实媒体，不调用系统关机。
class PipelineTool {
  static string Value(string[] args, string flag) { return args[Array.IndexOf(args, flag) + 1]; }
  static void Progress(string home, string stage, string message) {
    string marker = Path.Combine(home, "progress-" + stage + ".txt");
    if (!File.Exists(marker)) return;
    Console.Error.Write("\r" + message + "\r");
    Console.Error.Flush();
    for (int i = 0; i < 600 && File.Exists(marker); i++) Thread.Sleep(100);
  }
  static void Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    string home = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    if (File.Exists(Path.Combine(home, "python-unavailable.txt"))) {
      Console.Error.WriteLine("No Python at '\"Z:\\不可访问\\python.exe'");
      Environment.Exit(103);
    }
    if (args.Contains("--help")) {
      Console.WriteLine("--sub_formats --audio_suffixes --device --output_dir --identify --output --input --working-directory --post-export-action --post-export-video-command --cli --config-override --local-config-file -show_format -show_streams");
      return;
    }
    File.AppendAllText(Path.Combine(home, "calls.jsonl"), new JavaScriptSerializer().Serialize(args) + "\n", Encoding.UTF8);
    if (args.Contains("-show_format")) { Console.WriteLine("{\"format\":{\"duration\":\"10\"}}"); return; }
    if (args.Contains("-J")) {
      string path = args.Last();
      string sub = (path.Contains("-C") || path.Contains("-UC")) && !path.EndsWith(".jasna.mkv") ? ",{\"type\":\"subtitles\",\"properties\":{\"language\":\"chi\"}}" : "";
      Console.WriteLine("{\"container\":{\"recognized\":true,\"supported\":true},\"tracks\":[{\"type\":\"video\"},{\"type\":\"audio\"}" + sub + "]}");
      return;
    }
    string modePath = Path.Combine(home, "mode.txt");
    string mode = File.Exists(modePath) ? File.ReadAllText(modePath) : "";
    if (args.Contains("-cli") && File.Exists(Path.Combine(home, "fail-mdc-" + Path.GetFileNameWithoutExtension(args[1]) + ".txt"))) {
      Console.Error.WriteLine("未找到番号，隔离测试跳过当前文件");
      Environment.Exit(9);
    }
    if (mode == "挂起") { Console.WriteLine("替身等待取消"); Thread.Sleep(60000); }
    if (mode == "失败") { Console.Error.WriteLine("测试失败 token=不应显示"); Environment.Exit(9); }
    Thread.Sleep(500);
    if (args.Contains("--sub_formats")) {
      Progress(home, "vad", "VAD进度：1/4 块（25.0%）在 cuda 上");
      Progress(home, "transcribe", "[00:00.00 --> 00:05.00] 中文识别替身");
      string subtitle = args.Contains("--output_dir") ? Path.Combine(Value(args, "--output_dir"), Path.GetFileNameWithoutExtension(args.Last()) + ".srt") : Path.ChangeExtension(args.Last(), ".srt");
      File.WriteAllText(subtitle, "1\n00:00:00,500 --> 00:00:01,500\n中文测试字幕\n", new UTF8Encoding(false));
    } else if (args.Contains("-o")) {
      if (!args.Contains("--gui-mode")) Environment.Exit(12);
      Progress(home, "mux", "#GUI#progress 100%");
      File.Copy(Value(args, "--no-subtitles"), Value(args, "-o"), true);
    } else if (args.Contains("--input")) {
      Progress(home, "jasna", "Processing video: 42%|####|Processed: 0:02 (105f) | Remaining: 0:04 (145f) | Speed: 35.0fps");
      Progress(home, "jasna-" + Path.GetFileNameWithoutExtension(Value(args, "--input")), "Processing video: 42%|####|Processed: 0:02 (105f) | Remaining: 0:04 (145f) | Speed: 35.0fps");
      if (Value(args, "--post-export-action") != "none" || Value(args, "--post-export-video-command") != "") Environment.Exit(11);
      File.Copy(Value(args, "--input"), Value(args, "--output"), false);
    } else if (args.Contains("-cli")) {
      string video = args[1];
      string input = Path.GetDirectoryName(video);
      string outputRoot = args.First(x => x.StartsWith("common:success_folder=")).Substring("common:success_folder=".Length);
      string output = Path.Combine(outputRoot, Path.GetFileNameWithoutExtension(video));
      Directory.CreateDirectory(output);
      foreach (string path in Directory.GetFiles(input).Where(x => x == video || x.StartsWith(Path.Combine(input, Path.GetFileNameWithoutExtension(video) + "."))))
        File.Copy(path, Path.Combine(output, Path.GetFileName(path)), false);
      string stem = Path.GetFileNameWithoutExtension(video);
      string tags = (Regex.IsMatch(stem, @"-(C|UC)(_\d+)?$", RegexOptions.IgnoreCase) ? "<tag>中文字幕</tag>" : "") +
        (Regex.IsMatch(stem, @"-(U|UC|hack)(_\d+)?$", RegexOptions.IgnoreCase) ? "<tag>破解</tag>" : "");
      File.WriteAllText(Path.Combine(output, stem + ".nfo"), "<movie><title>隔离测试</title>" + (mode == "丢标签" ? "" : tags) + "</movie>", new UTF8Encoding(false));
      File.WriteAllText(Path.Combine(output, "poster.jpg"), "测试封面替身");
    }
    Console.WriteLine("替身处理完成，token=不应显示");
  }
}
