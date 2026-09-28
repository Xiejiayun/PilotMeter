using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

[assembly: AssemblyTitle("PilotMeter")]
[assembly: AssemblyDescription("Local Copilot CLI usage meter")]
[assembly: AssemblyCompany("PilotMeter contributors")]
[assembly: AssemblyProduct("PilotMeter")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal static class Launcher
{
    private sealed class Member
    {
        internal string Hash;
        internal long Length;
        internal string Path;
    }

    private static string Hash(Stream stream)
    {
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static Stream Resource(string name)
    {
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (stream == null) throw new InvalidDataException("The executable is missing " + name + ".");
        return stream;
    }

    private static List<Member> Manifest()
    {
        var members = new List<Member>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using (var reader = new StreamReader(Resource("PilotMeter.Manifest"), Encoding.UTF8))
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                var fields = line.Split('\t');
                long length;
                if (fields.Length != 3 || fields[0].Length != 64 ||
                    !long.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out length) ||
                    length < 0 || !names.Add(fields[2]))
                    throw new InvalidDataException("The executable file manifest is invalid.");
                members.Add(new Member { Hash = fields[0], Length = length, Path = fields[2] });
            }
        }
        if (members.Count == 0) throw new InvalidDataException("The executable file manifest is empty.");
        return members;
    }

    private static string Within(string root, string relative)
    {
        if (String.IsNullOrEmpty(relative) || relative.IndexOf('\\') >= 0 ||
            relative.IndexOf(':') >= 0 || Path.IsPathRooted(relative))
            throw new InvalidDataException("The executable contains an invalid path.");
        foreach (var part in relative.Split('/'))
            if (part == "." || part == ".." || part.Length == 0)
                throw new InvalidDataException("The executable contains an invalid path.");
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(Path.Combine(fullRoot, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("A bundled file is outside its runtime directory.");
        return path;
    }

    private static void Verify(string root, List<Member> members)
    {
        foreach (var member in members)
        {
            var path = Within(root, member.Path);
            var info = new FileInfo(path);
            if (!info.Exists || info.Length != member.Length || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Bundled runtime is incomplete or changed: " + path +
                    ". Stop PilotMeter, rename this runtime directory, and launch the EXE again. Usage data is separate.");
            using (var file = File.OpenRead(path))
                if (Hash(file) != member.Hash)
                    throw new InvalidDataException("Bundled runtime integrity check failed: " + path +
                        ". Stop PilotMeter, rename this runtime directory, and launch the EXE again. Usage data is separate.");
        }
    }

    private static FileStream Lock(string path)
    {
        var timer = Stopwatch.StartNew();
        while (true)
        {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException)
            {
                if (timer.Elapsed > TimeSpan.FromSeconds(60))
                    throw new IOException("Another PilotMeter launch is still preparing its runtime. Try again shortly.");
                Thread.Sleep(100);
            }
        }
    }

    private static string PrepareRuntime()
    {
        var local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (String.IsNullOrWhiteSpace(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (String.IsNullOrWhiteSpace(local) || !Path.IsPathRooted(local))
            throw new IOException("A writable absolute LOCALAPPDATA directory is required.");
        var root = Path.Combine(local, "PilotMeter", "runtime");
        Directory.CreateDirectory(root);
        var name = BuildInfo.Version + "-" + BuildInfo.PayloadHash.Substring(0, 16);
        var destination = Path.Combine(root, name);
        var members = Manifest();
        using (Lock(Path.Combine(root, name + ".lock")))
        {
            if (Directory.Exists(destination))
            {
                Verify(destination, members);
                return destination;
            }
            // Stage in a new sibling and publish only after every bundled file is verified.
            // Interrupted extraction never becomes a usable runtime, and is never confused with usage data.
            var staging = Path.Combine(root, name + ".partial-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            using (var payload = Resource("PilotMeter.Payload"))
            {
                if (Hash(payload) != BuildInfo.PayloadHash)
                    throw new InvalidDataException("The executable payload is damaged. Download a fresh copy.");
                payload.Position = 0;
                using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    if (zip.Entries.Count != members.Count)
                        throw new InvalidDataException("The executable archive does not match its manifest.");
                    foreach (var member in members)
                    {
                        var entry = zip.GetEntry(member.Path);
                        if (entry == null || entry.Length != member.Length)
                            throw new InvalidDataException("The executable archive contains an unexpected file.");
                        var target = Within(staging, member.Path);
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (var source = entry.Open())
                        using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                            source.CopyTo(output);
                    }
                }
            }
            Verify(staging, members);
            Directory.Move(staging, destination);
        }
        return destination;
    }

    // Windows CommandLineToArgvW / CRT quoting; no cmd.exe or PowerShell evaluates user arguments.
    private static string Quote(string value)
    {
        var output = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') output.Append('\\', slashes * 2 + 1);
            else output.Append('\\', slashes);
            slashes = 0;
            output.Append(character);
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }

    private static void KeepErrorVisible(string[] args)
    {
        if (args.Length == 0 && Environment.UserInteractive && !Console.IsInputRedirected)
        {
            Console.Error.WriteLine("Press any key to close.");
            Console.ReadKey(true);
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (!Environment.Is64BitOperatingSystem)
                throw new PlatformNotSupportedException("This PilotMeter build requires 64-bit Windows.");
            var root = PrepareRuntime();
            var command = new StringBuilder(Quote(Path.Combine(root, "app", "bin", "pilotmeter.js")));
            var forwarded = args.Length == 0 ? new[] { "start", "--background", "--open" } : args;
            foreach (var argument in forwarded) command.Append(" ").Append(Quote(argument));
            var executable = Path.Combine(root, "runtime", "node.exe");
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
            var exitCode = NativeChild.Run(executable, Quote(executable) + " " + command, Environment.CurrentDirectory);
            if (exitCode != 0) KeepErrorVisible(args);
            return exitCode;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("PilotMeter: " + error.Message);
            KeepErrorVisible(args);
            return 1;
        }
    }
}
