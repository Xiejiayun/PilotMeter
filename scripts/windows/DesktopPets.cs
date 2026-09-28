using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

internal sealed class DesktopPetDefinition
{
    internal readonly string Id, Name, Description;
    internal DesktopPetDefinition(string id, string name, string description) { Id = id; Name = name; Description = description; }
    public override string ToString() { return Id + "  " + Name + " · " + Description; }
}

internal static class DesktopPetCatalog
{
    private static readonly IList<DesktopPetDefinition> all = Array.AsReadOnly(new[] {
        new DesktopPetDefinition("01", "小航", "戴护目镜的小飞行员"), new DesktopPetDefinition("02", "橘团", "伸出小爪的橘白猫"),
        new DesktopPetDefinition("03", "麦麦", "戴围巾的奶油柴犬"), new DesktopPetDefinition("04", "豆豆", "招手的小企鹅"),
        new DesktopPetDefinition("05", "啵啵", "薄荷色软糖团"), new DesktopPetDefinition("06", "比特", "搪瓷小机器人"),
        new DesktopPetDefinition("07", "云咩", "戴星星的云朵精灵"), new DesktopPetDefinition("08", "芽芽", "顶着双叶的小豆子"),
        new DesktopPetDefinition("09", "露露", "轻盈的星光水母"), new DesktopPetDefinition("10", "小焰", "复古像素小龙")
    });
    internal static IList<DesktopPetDefinition> All { get { return all; } }
    internal static DesktopPetDefinition Find(string id) { foreach (var pet in all) if (pet.Id == id) return pet; return null; }
    // Every caller owns an independent bitmap; no stream or shared image escapes.
    internal static Bitmap CreateBitmap(string id)
    {
        if (Find(id) == null) throw new ArgumentException("请选择有效的桌面宠物。", "id");
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PilotMeter.Pets." + id))
        {
            if (stream == null) throw new InvalidDataException("桌面宠物资源缺失，请重新打开完整的 PilotMeter EXE。");
            using (var source = new Bitmap(stream))
            {
                if (source.Width != 512 || source.Height != 512) throw new InvalidDataException("桌面宠物资源尺寸无效。");
                var result = new Bitmap(512, 512, PixelFormat.Format32bppPArgb);
                try { using (var graphics = Graphics.FromImage(result)) graphics.DrawImageUnscaled(source, 0, 0); return result; }
                catch { result.Dispose(); throw; }
            }
        }
    }
}

// UI-thread owned. This is the sole writer of desktop-ui.json; it never touches account data.
internal sealed class DesktopPetPreferences
{
    private readonly string path;
    private string petId = "01";
    private int sizePixels = 96;
    private bool motionEnabled = true, alwaysOnTop = true;
    private Point? location;
    internal event EventHandler Changed;
    internal string PetId { get { return petId; } }
    internal int SizePixels { get { return sizePixels; } }
    internal bool MotionEnabled { get { return motionEnabled; } }
    internal bool AlwaysOnTop { get { return alwaysOnTop; } }
    internal Point? Location { get { return location; } }
    internal string PersistenceWarning { get; private set; }
    internal DesktopPetPreferences(string directory)
    {
        if (String.IsNullOrWhiteSpace(directory)) throw new ArgumentException("需要桌面数据目录。", "directory");
        path = Path.Combine(Path.GetFullPath(directory), "desktop-ui.json"); Read();
    }
    internal void SelectPet(string id)
    {
        if (DesktopPetCatalog.Find(id) == null) throw new ArgumentException("请选择有效的桌面宠物。", "id");
        if (petId == id) return; petId = id; Commit();
    }
    internal void SetSize(int pixels)
    {
        if (pixels < 64 || pixels > 160) throw new ArgumentOutOfRangeException("pixels", "宠物尺寸为 64 至 160 像素。");
        if (sizePixels == pixels) return; sizePixels = pixels; Commit();
    }
    internal void SetMotion(bool enabled) { if (motionEnabled != enabled) { motionEnabled = enabled; Commit(); } }
    internal void SetAlwaysOnTop(bool enabled) { if (alwaysOnTop != enabled) { alwaysOnTop = enabled; Commit(); } }
    internal void SetPosition(Point position)
    {
        if (position.X < -100000 || position.X > 100000 || position.Y < -100000 || position.Y > 100000) return;
        if (location == position && PersistenceWarning == null) return; location = position; Save();
    }
    private void Commit() { Save(); var handler = Changed; if (handler != null) handler(this, EventArgs.Empty); }
    private static int Number(Dictionary<string, object> value, string key, int minimum, int maximum)
    {
        object raw;
        if (!value.TryGetValue(key, out raw) || !(raw is int) || (int)raw < minimum || (int)raw > maximum) throw new InvalidDataException();
        return (int)raw;
    }
    private static bool Flag(Dictionary<string, object> value, string key)
    {
        object raw; if (!value.TryGetValue(key, out raw) || !(raw is bool)) throw new InvalidDataException(); return (bool)raw;
    }
    private void Read()
    {
        try
        {
            if (!File.Exists(path)) return;
            string json;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream, Encoding.UTF8, true))
            {
                if (stream.Length > 8192) throw new InvalidDataException();
                var characters = new char[8193]; int count = reader.ReadBlock(characters, 0, characters.Length);
                if (count > 8192) throw new InvalidDataException(); json = new string(characters, 0, count);
            }
            var values = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 8 }.Deserialize<Dictionary<string, object>>(json);
            if (values == null) throw new InvalidDataException();
            int version = Number(values, "version", 1, 2); bool top = Flag(values, "topmost"); Point? point = null;
            if (values.ContainsKey("x") || values.ContainsKey("y")) point = new Point(Number(values, "x", -100000, 100000), Number(values, "y", -100000, 100000));
            string id = "01"; int size = 96; bool motion = true;
            if (version == 2)
            {
                object raw;
                if (!values.TryGetValue("petId", out raw) || !(raw is string) || DesktopPetCatalog.Find((string)raw) == null) throw new InvalidDataException();
                id = (string)raw; size = Number(values, "size", 64, 160); motion = Flag(values, "motion");
            }
            // Apply only after the complete record is validated, including a legacy v1 position.
            petId = id; sizePixels = size; motionEnabled = motion; alwaysOnTop = top; location = point;
        }
        catch (Exception error)
        {
            if (!(error is IOException) && !(error is InvalidDataException) && !(error is UnauthorizedAccessException) && !(error is ArgumentException) && !(error is InvalidOperationException)) throw;
            PersistenceWarning = "宠物设置暂不可用，已使用默认外观与可见位置。";
        }
    }
    private void Save()
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var values = new Dictionary<string, object> { { "version", 2 }, { "petId", petId }, { "size", sizePixels }, { "motion", motionEnabled }, { "topmost", alwaysOnTop } };
            if (location.HasValue) { values.Add("x", location.Value.X); values.Add("y", location.Value.Y); }
            byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(values));
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path); PersistenceWarning = null;
        }
        catch (IOException) { PersistenceWarning = "宠物设置尚未保存；本次选择仍然生效。"; }
        catch (UnauthorizedAccessException) { PersistenceWarning = "宠物设置尚未保存；本次选择仍然生效。"; }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }
}

internal static class DesktopPetRenderer
{
    internal static Size LogicalSize(int petSize) { return new Size(Math.Max(140, petSize + 12), petSize + 46); }
    internal static Point KeepVisible(Point point, Size size, Rectangle area)
    {
        return new Point(Math.Max(area.Left, Math.Min(point.X, area.Right - size.Width)), Math.Max(area.Top, Math.Min(point.Y, area.Bottom - size.Height)));
    }
    internal static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath(); float diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90); path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90); path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure(); return path;
    }
    internal static Bitmap Render(Bitmap pet, int size, float dpiScale, double phase, string caption, bool focus, bool pixelArt, string unit = null)
    {
        if (pet == null) throw new ArgumentNullException("pet");
        if (size < 64 || size > 160 || Single.IsNaN(dpiScale) || Single.IsInfinity(dpiScale) || dpiScale < .1f || dpiScale > 4f) throw new ArgumentOutOfRangeException("size");
        Size logical = LogicalSize(size);
        var result = new Bitmap(Math.Max(1, (int)Math.Round(logical.Width * dpiScale)), Math.Max(1, (int)Math.Round(logical.Height * dpiScale)), PixelFormat.Format32bppPArgb);
        try
        {
            using (Graphics graphics = Graphics.FromImage(result))
            {
                graphics.Clear(Color.Transparent); graphics.ScaleTransform(dpiScale, dpiScale); graphics.SmoothingMode = SmoothingMode.AntiAlias; graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                graphics.InterpolationMode = pixelArt ? InterpolationMode.NearestNeighbor : InterpolationMode.HighQualityBicubic; graphics.PixelOffsetMode = PixelOffsetMode.Half;
                float breath = (float)Math.Sin(phase) * .012f; float width = size * (1 + breath), height = size * (1 - breath);
                graphics.DrawImage(pet, new RectangleF((logical.Width - width) / 2, 2 + size - height, width, height));
                var label = new RectangleF(4, size + 5, logical.Width - 8, 37);
                using (var shape = Rounded(label, 12))
                using (var background = new SolidBrush(Color.FromArgb(242, 248, 251, 247)))
                using (var border = new Pen(focus ? Color.FromArgb(83, 143, 102) : Color.FromArgb(185, 211, 198), focus ? 1.6f : 1))
                { graphics.FillPath(background, shape); graphics.DrawPath(border, shape); }
                using (var font = new Font(SystemFonts.MessageBoxFont.FontFamily, 10.5f, FontStyle.Regular, GraphicsUnit.Pixel))
                using (var brush = new SolidBrush(Color.FromArgb(48, 80, 62)))
                using (var format = new StringFormat(StringFormatFlags.NoWrap) { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter })
                    graphics.DrawString(caption, font, brush, new RectangleF(label.X + 8, label.Y + (unit == null ? 0 : 2), label.Width - 16, unit == null ? label.Height : 18), format);
                if (unit != null)
                using (var font = new Font(SystemFonts.MessageBoxFont.FontFamily, 9, FontStyle.Regular, GraphicsUnit.Pixel))
                using (var brush = new SolidBrush(Color.FromArgb(91, 115, 100)))
                using (var format = new StringFormat(StringFormatFlags.NoWrap) { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter })
                    graphics.DrawString(unit, font, brush, new RectangleF(label.X + 6, label.Y + 19, label.Width - 12, 14), format);
            }
            return result;
        }
        catch { result.Dispose(); throw; }
    }
}
