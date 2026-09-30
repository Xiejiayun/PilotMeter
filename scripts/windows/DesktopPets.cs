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
    internal static DesktopPetAnimation CreateAnimation(string id)
    {
        if (Find(id) == null) throw new ArgumentException("请选择有效的桌面宠物。", "id");
        return new DesktopPetAnimation(id);
    }
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

internal enum DesktopPetReactionKind { None, Update, Message, Attention }

// Only the selected PET owns these cropped layers. Authored limbs keep their
// original painter's order and move around their joints, rather than moving a
// rectangular screenshot of the complete character. All resources are offline.
internal sealed class DesktopPetAnimation : IDisposable
{
    private sealed class LayerDefinition
    {
        public string key { get; set; }
        public float pivotX { get; set; }
        public float pivotY { get; set; }
        public float x { get; set; }
        public float y { get; set; }
        public float width { get; set; }
        public float height { get; set; }
    }
    private sealed class Layer : IDisposable
    {
        internal LayerDefinition Definition;
        internal Bitmap Image;
        public void Dispose() { if (Image != null) { Image.Dispose(); Image = null; } }
    }
    private readonly List<Layer> layers = new List<Layer>();
    private bool disposed;
    internal string PetId { get; private set; }
    internal int LayerCount { get { return layers.Count; } }
    internal DesktopPetAnimation(string id)
    {
        PetId = id;
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            LayerDefinition[] definitions;
            using (var stream = assembly.GetManifestResourceStream("PilotMeter.Pets.Animation." + id + ".json"))
            {
                if (stream == null || stream.Length > 8192) throw new InvalidDataException("宠物动作资源缺失。");
                using (var reader = new StreamReader(stream, Encoding.UTF8))
                    definitions = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 8 }.Deserialize<LayerDefinition[]>(reader.ReadToEnd());
            }
            if (definitions == null || definitions.Length < 3 || definitions.Length > 10) throw new InvalidDataException("宠物动作资源无效。");
            for (int index = 0; index < definitions.Length; index++)
            {
                LayerDefinition definition = definitions[index];
                if (definition == null || String.IsNullOrEmpty(definition.key) || definition.width <= 0 || definition.height <= 0 ||
                    definition.x < 0 || definition.y < 0 || definition.x + definition.width > 128 || definition.y + definition.height > 128)
                    throw new InvalidDataException("宠物动作图层无效。");
                using (var stream = assembly.GetManifestResourceStream("PilotMeter.Pets.Animation." + id + "." + index.ToString("D2")))
                {
                    if (stream == null) throw new InvalidDataException("宠物动作图层缺失。");
                    using (var source = new Bitmap(stream))
                    {
                        if (source.Width != (int)Math.Round(definition.width * 4) || source.Height != (int)Math.Round(definition.height * 4))
                            throw new InvalidDataException("宠物动作图层尺寸无效。");
                        var layer = new Layer { Definition = definition, Image = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppPArgb) };
                        layers.Add(layer);
                        using (var graphics = Graphics.FromImage(layer.Image)) graphics.DrawImageUnscaled(source, 0, 0);
                    }
                }
            }
        }
        catch { Dispose(); throw; }
    }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true; foreach (var layer in layers) layer.Dispose(); layers.Clear();
    }
    internal void Draw(Graphics graphics, RectangleF bounds, DesktopPetReactionKind reaction, double progress, double phase = 0, bool idleMotion = false)
    {
        if (disposed) throw new ObjectDisposedException("DesktopPetAnimation");
        bool reacting = reaction != DesktopPetReactionKind.None && progress > 0 && progress < 1;
        if (!reacting && !idleMotion) return;
        if (!reacting) { reaction = DesktopPetReactionKind.None; progress = 0; }
        if (Double.IsNaN(phase) || Double.IsInfinity(phase)) phase = 0;
        bool message = reaction == DesktopPetReactionKind.Message;
        bool attention = reaction == DesktopPetReactionKind.Attention;
        // The event envelope has zero velocity at both ends. Idle uses the
        // caller's continuous clock, so a gesture settles into the current
        // idle pose without restarting its cycle or switching bitmap paths.
        float edge = (float)Math.Sin(progress * Math.PI);
        float envelope = edge * edge;
        double cycles = attention ? 3.5 : message ? 3 : 2;
        float wave = (float)Math.Sin(progress * Math.PI * 2 * cycles) * envelope;
        float gesture = (float)(.5 - .5 * Math.Cos(progress * Math.PI * 2 * cycles)) * envelope;
        float strength = message ? 1.15f : attention ? .9f : 1;
        var outer = graphics.Save();
        try
        {
            graphics.TranslateTransform(bounds.X, bounds.Y);
            graphics.ScaleTransform(bounds.Width / 128, bounds.Height / 128);
            foreach (var layer in layers)
            {
                LayerDefinition item = layer.Definition;
                var state = graphics.Save();
                try
                {
                    // Ground shadows stay anchored while the character reacts.
                    if (item.key != "shadow") ApplyCharacterMotion(graphics, PetId, wave, gesture, envelope, strength, phase, idleMotion);
                    float angle = 0, scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;
                    switch (item.key)
                    {
                        case "pilot-hand": angle = (-10 * gesture + 24 * wave) * strength; break;
                        case "scarf": angle = 15 * wave * strength; break;
                        case "cat-tail": angle = 19 * wave * strength; break;
                        case "cat-paw": angle = (21 * wave + 11 * gesture) * strength; break;
                        case "shiba-tail": angle = (float)Math.Sin(progress * Math.PI * (message ? 18 : 14)) * envelope * 27; break;
                        case "penguin-left": angle = -(message ? 31 : 17) * gesture; break;
                        case "penguin-right": angle = (22 * wave + 9 * gesture) * strength; break;
                        case "slime-left": angle = 25 * wave; break;
                        case "slime-right": angle = -25 * wave; break;
                        case "antenna": angle = 24 * wave * strength; break;
                        case "robot-left": angle = (message ? 48 : 22) * gesture; break;
                        case "robot-right": angle = -85 * gesture + 12 * wave; break;
                        case "star": angle = 32 * wave * strength; break;
                        case "sparkle": angle = 48 * wave; offsetX = -7 * gesture; offsetY = -4 * envelope; scaleX = scaleY = 1 + .2f * gesture; break;
                        case "leaf-left": angle = (15 * wave - 8 * gesture) * strength; break;
                        case "leaf-right": angle = (-15 * wave + 8 * gesture) * strength; break;
                        case "wing": scaleX = 1 - .65f * gesture; angle = -10 * wave; break;
                        case "dragon-hand": offsetY = -4 * gesture; break;
                        default:
                            if (item.key.StartsWith("tentacle-", StringComparison.Ordinal))
                            {
                                int index = item.key[item.key.Length - 1] - '0';
                                float ripple = (float)Math.Sin(progress * Math.PI * 2 * cycles - index * .65) * envelope;
                                angle = 14 * ripple * strength; scaleY = 1 - .13f * gesture;
                            }
                            break;
                    }
                    if (idleMotion) ApplyIdleLayerMotion(item.key, phase, ref angle, ref scaleX, ref scaleY, ref offsetX, ref offsetY);
                    graphics.TranslateTransform(item.pivotX + offsetX, item.pivotY + offsetY);
                    graphics.RotateTransform(angle); graphics.ScaleTransform(scaleX, scaleY);
                    graphics.TranslateTransform(-item.pivotX, -item.pivotY);
                    graphics.DrawImage(layer.Image, new RectangleF(item.x, item.y, item.width, item.height));
                }
                finally { graphics.Restore(state); }
            }
        }
        finally { graphics.Restore(outer); }
    }
    private static void ApplyIdleLayerMotion(string key, double phase, ref float angle, ref float scaleX, ref float scaleY, ref float offsetX, ref float offsetY)
    {
        // Idle joint motion stays roughly one quarter of the event gestures.
        // Different periods keep the pets' movement gentle and characteristic.
        switch (key)
        {
            case "pilot-hand": angle += 2.5f * (float)Math.Sin(phase * .8 + .4); break;
            case "scarf": angle += 7 * (float)Math.Sin(phase * 1.15); break;
            case "cat-tail": angle += 7 * (float)Math.Sin(phase * 1.25); break;
            case "cat-paw": angle += 2.5f * (float)Math.Sin(phase * .9 + .6); break;
            case "shiba-tail": angle += 9 * (float)Math.Sin(phase * 1.9); break;
            case "penguin-left": angle += 3 * (float)Math.Sin(phase * .95 + .3); break;
            case "penguin-right": angle += 5.5f * (float)Math.Sin(phase * .95); break;
            case "slime-left": angle += 5 * (float)Math.Sin(phase * 1.15); break;
            case "slime-right": angle -= 5 * (float)Math.Sin(phase * 1.15); break;
            case "antenna": angle += 6 * (float)Math.Sin(phase * 1.3); break;
            case "robot-left": angle += 2 * (float)Math.Sin(phase * .85); break;
            case "robot-right": angle -= 3 * (float)Math.Sin(phase * .85 + .4); break;
            case "star": angle += 7 * (float)Math.Sin(phase * 1.05); break;
            case "sparkle":
                angle += 9 * (float)Math.Sin(phase * .8); offsetX += 1.5f * (float)Math.Sin(phase * .65);
                offsetY += (float)Math.Sin(phase * .85); scaleX *= 1 + .05f * (float)Math.Sin(phase * 1.1); scaleY *= 1 + .05f * (float)Math.Sin(phase * 1.1);
                break;
            case "leaf-left": angle += 6 * (float)Math.Sin(phase * .95); break;
            case "leaf-right": angle -= 6 * (float)Math.Sin(phase * .95 + .35); break;
            case "wing": scaleX *= 1 - .09f * (float)(.5 - .5 * Math.Cos(phase * 1.2)); angle -= 2 * (float)Math.Sin(phase * 1.2); break;
            case "dragon-hand": offsetY -= .7f * (float)(.5 - .5 * Math.Cos(phase * .9)); break;
            default:
                if (key.StartsWith("tentacle-", StringComparison.Ordinal))
                {
                    int index = key[key.Length - 1] - '0';
                    float ripple = (float)Math.Sin(phase * 1.1 - index * .65);
                    angle += 4.5f * ripple; scaleY *= 1 + .025f * ripple;
                }
                break;
        }
    }
    private static void ApplyCharacterMotion(Graphics graphics, string id, float wave, float gesture, float envelope, float strength, double phase, bool idleMotion)
    {
        float angle = 0, scaleX = 1, scaleY = 1, lift = 0;
        switch (id)
        {
            case "01": lift = 1.5f * gesture; break;
            case "02": angle = 2 * wave; break;
            case "03": lift = 2.5f * gesture; break;
            case "04": angle = 3.5f * wave; break;
            case "05": scaleX = 1 + .1f * wave; scaleY = 1 - .13f * wave; lift = 3 * gesture; break;
            case "06": lift = 1.5f * gesture; break;
            case "07": lift = 5 * envelope; angle = 2 * wave; break;
            case "08": lift = 2 * gesture; break;
            case "09": lift = 4 * envelope; scaleX = 1 + .025f * wave; break;
            case "10": lift = 4 * gesture; break;
        }
        lift *= strength;
        if (idleMotion)
        {
            switch (id)
            {
                case "01": angle += .45f * (float)Math.Sin(phase * .73); break;
                case "02": angle += .6f * (float)Math.Sin(phase * .85); break;
                case "03": lift += .35f * (float)(1 - Math.Cos(phase * 1.4)); break;
                case "04": angle += .9f * (float)Math.Sin(phase * .95); break;
                case "05":
                    float wobble = (float)Math.Sin(phase * 1.15);
                    scaleX *= 1 + .025f * wobble; scaleY *= 1 - .035f * wobble;
                    break;
                case "06": lift += .35f * (float)(1 - Math.Cos(phase * 1.25)); break;
                case "07": lift += 1.6f * (float)(1 + Math.Sin(phase * .8)); break;
                case "08": angle += .55f * (float)Math.Sin(phase * .85); break;
                case "09": lift += 1.3f * (float)(1 + Math.Sin(phase * .85)); scaleX *= 1 + .012f * (float)Math.Sin(phase * 1.1); break;
                case "10": lift += .4f * (float)(1 - Math.Cos(phase * .8)); break;
            }
        }
        graphics.TranslateTransform(64, 109 - lift); graphics.RotateTransform(angle);
        graphics.ScaleTransform(scaleX, scaleY); graphics.TranslateTransform(-64, -109);
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
    internal static Bitmap Render(Bitmap pet, int size, float dpiScale, double phase, string caption, bool focus, bool pixelArt, string unit = null, bool syncing = false, double updateProgress = -1, DesktopPetAnimation animation = null, DesktopPetReactionKind reaction = DesktopPetReactionKind.None, double reactionProgress = -1, bool idleMotion = false)
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
                float pulse = updateProgress >= 0 && updateProgress < 1 ? (float)(Math.Sin(updateProgress * Math.PI) * Math.Sqrt(1 - updateProgress)) : 0;
                float breath = (float)Math.Sin(phase * (syncing ? 4 : 1)) * (syncing ? .022f : .012f) + pulse * .035f;
                float width = size * (1 + breath), height = size * (1 - breath);
                float lift = pulse * size * .07f + (syncing ? (float)(1 - Math.Cos(phase * 4)) * 1.5f : 0);
                var petBounds = new RectangleF((logical.Width - width) / 2, 2 + size - height - lift, width, height);
                if (animation != null && (idleMotion || reaction != DesktopPetReactionKind.None && reactionProgress > 0 && reactionProgress < 1))
                    animation.Draw(graphics, petBounds, reaction, reactionProgress, phase, idleMotion);
                else graphics.DrawImage(pet, petBounds);
                if (syncing)
                {
                    var indicator = new RectangleF(logical.Width - 22, size - 13, 15, 15);
                    using (var background = new SolidBrush(Color.FromArgb(250, 237, 247, 240))) graphics.FillEllipse(background, indicator);
                    using (var pen = new Pen(Color.FromArgb(73, 140, 99), 1.8f))
                    {
                        pen.StartCap = pen.EndCap = LineCap.Round;
                        graphics.DrawArc(pen, indicator.X + 3, indicator.Y + 3, 9, 9, (float)(phase * 230 % 360), 265);
                    }
                }
                var label = new RectangleF(4, size + 5, logical.Width - 8, 37);
                using (var shape = Rounded(label, 12))
                using (var background = new SolidBrush(Color.FromArgb(242, 248, 251, 247)))
                using (var border = new Pen(pulse > 0 ? Color.FromArgb((int)(185 - 102 * pulse), (int)(211 - 68 * pulse), (int)(198 - 96 * pulse)) : focus ? Color.FromArgb(83, 143, 102) : Color.FromArgb(185, 211, 198), Math.Max(focus ? 1.6f : 1, 1 + pulse)))
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
