using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text;

// Windowless checks exercise the shipping embedded assets and isolated preference files.
internal static class DesktopPetTests
{
    private static int assertions;
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); assertions++; }
    private static void Reject(Action action, string message)
    {
        try { action(); } catch (ArgumentException) { assertions++; return; } catch (InvalidDataException) { assertions++; return; } catch (InvalidOperationException) { assertions++; return; }
        throw new Exception(message);
    }
    private static string Digest(Bitmap bitmap)
    {
        using (var memory = new MemoryStream()) using (var sha = SHA256.Create())
        { bitmap.Save(memory, ImageFormat.Png); return Convert.ToBase64String(sha.ComputeHash(memory.ToArray())); }
    }
    internal static int Run(string parent)
    {
        assertions = 0;
        Check(DesktopPetCatalog.All.Count == 10, "Exactly ten pets must ship.");
        var ids = new HashSet<string>(); var images = new HashSet<string>();
        foreach (var pet in DesktopPetCatalog.All)
        {
            Check(ids.Add(pet.Id) && DesktopPetCatalog.Find(pet.Id) == pet, "Every pet must have one stable identity.");
            using (Bitmap image = DesktopPetCatalog.CreateBitmap(pet.Id))
            {
                Check(image.Size == new Size(512, 512) && image.GetPixel(0, 0).A == 0, "Every embedded pet must retain its 512px transparent image.");
                Check(images.Add(Digest(image)), "Pets must have distinct image content.");
                foreach (int size in new[] { 64, 96, 160 })
                foreach (float scale in new[] { 1f, 1.25f, 1.5f, 2f })
                using (Bitmap rendered = DesktopPetRenderer.Render(image, size, scale, 0, "剩余 60%", false, pet.Id == "10"))
                {
                    Size logical = DesktopPetRenderer.LogicalSize(size);
                    Check(rendered.Width == (int)Math.Round(logical.Width * scale) && rendered.Height == (int)Math.Round(logical.Height * scale), "Rendered size must follow the selected size and monitor DPI.");
                    Check(rendered.GetPixel(0, 0).A == 0 && rendered.GetPixel(rendered.Width - 1, rendered.Height - 1).A == 0, "The pet must not acquire an opaque window background.");
                }
            }
        }
        using (var first = DesktopPetCatalog.CreateBitmap("01"))
        using (var second = DesktopPetCatalog.CreateBitmap("01"))
        {
            first.SetPixel(0, 0, Color.Red); Check(second.GetPixel(0, 0).A == 0, "Image owners must not modify other previews.");
            using (var still = DesktopPetRenderer.Render(second, 96, 1, 0, "剩余 60%", false, false))
            using (var breath = DesktopPetRenderer.Render(second, 96, 1, Math.PI / 2, "剩余 60%", false, false))
                Check(Digest(still) != Digest(breath), "Breathing must change the pet pixels.");
        }
        Reject(delegate { DesktopPetCatalog.CreateBitmap("../01"); }, "Resource ids must not accept paths.");
        Check(DesktopPetRenderer.KeepVisible(new Point(-2200, -80), new Size(140, 130), new Rectangle(-1920, 0, 1920, 1040)) == new Point(-1920, 0), "Negative-coordinate monitors must keep the pet visible.");
        Check(DesktopPetRenderer.KeepVisible(new Point(5000, 5000), new Size(140, 130), new Rectangle(0, 0, 1920, 1040)) == new Point(1780, 910), "A removed monitor position must return inside the working area.");
        var stale = DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "stale", Value = "剩余 99999", Percentage = 40 });
        Check(stale.Percentage == null && !DesktopWidget.Caption(stale).Contains("99999"), "A stale quota must not remain in the compact caption.");
        var invalid = DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "ready", Percentage = Double.NaN, AccountLogin = "sample\r\nperson" });
        Check(invalid.Percentage == null && !invalid.AccountLogin.Contains("\n"), "Malformed percentages and multiline identities must be sanitized.");
        var knownUnit = DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "ready", Value = "75 剩余", UnitLabel = "AI Credits" });
        Check(DesktopWidget.CaptionUnit(knownUnit) == "AI Credits", "An absolute quota caption must retain the confirmed unit.");
        var unknownUnit = DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "ready", Value = "剩余 75%", UnitUnspecified = true });
        Check(DesktopWidget.CaptionUnit(unknownUnit) == "单位未确认", "An unconfirmed unit must remain visible beside an official percentage.");
        knownUnit.State = "stale"; Check(DesktopWidget.CaptionUnit(knownUnit) == null, "A stale caption must not retain a live quota unit.");
        var gate = new WidgetSnapshotGate(); long beforeSwitch = gate.Capture();
        Check(gate.Accepts(beforeSwitch), "A current snapshot should initially be accepted.");
        gate.BeginMutation();
        Check(!gate.CanRead && !gate.Accepts(beforeSwitch) && !gate.Accepts(gate.Capture()), "Starting a login or switch must block every snapshot, including new GETs of the old active account.");
        gate.EndMutation();
        Check(gate.CanRead && !gate.Accepts(beforeSwitch) && gate.Accepts(gate.Capture()), "Only a read started after the account operation may refill the widget.");
        long previousCategory = gate.Capture(); gate.Invalidate();
        Check(!gate.Accepts(previousCategory), "A late response for the previous quota category must be discarded.");
        gate.BeginMutation(); gate.BeginMutation(); gate.EndMutation();
        Check(!gate.CanRead, "Finishing one overlapping operation must not unblock another pending operation.");
        gate.EndMutation(); Check(gate.CanRead, "The final account operation must release the read barrier.");
        Reject(delegate { gate.EndMutation(); }, "A mismatched completion must not underflow the read barrier.");

        string directory = Path.Combine(Path.GetFullPath(parent), "pet-preferences-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory); string settings = Path.Combine(directory, "desktop-ui.json");
        string blocker = Path.Combine(directory, "blocked-parent");
        try
        {
            var preferences = new DesktopPetPreferences(directory);
            Check(preferences.PetId == "01" && preferences.SizePixels == 96 && preferences.MotionEnabled && preferences.AlwaysOnTop && preferences.Location == null, "New installs need a consistent visible default.");
            int changes = 0; preferences.Changed += delegate { changes++; };
            preferences.SelectPet("06"); preferences.SetSize(128); preferences.SetMotion(false); preferences.SetAlwaysOnTop(false); preferences.SetPosition(new Point(-500, 200));
            var reloaded = new DesktopPetPreferences(directory);
            Check(reloaded.PetId == "06" && reloaded.SizePixels == 128 && !reloaded.MotionEnabled && !reloaded.AlwaysOnTop && reloaded.Location == new Point(-500, 200), "Appearance and a secondary-monitor position must survive a restart.");
            Check(changes == 4, "Only appearance changes notify preview subscribers.");
            preferences.SelectPet("06"); Check(changes == 4, "Selecting the current pet must not re-render or rewrite state.");
            Reject(delegate { preferences.SelectPet("11"); }, "Unknown pets must be rejected.");
            Reject(delegate { preferences.SetSize(63); }, "Too-small pets must be rejected.");
            Reject(delegate { preferences.SetSize(161); }, "Too-large pets must be rejected.");
            Check(preferences.PetId == "06" && preferences.SizePixels == 128 && changes == 4, "Invalid setters must leave the current choice intact.");
            Check(Directory.GetFiles(directory, "*.tmp").Length == 0, "Successful atomic preference writes must leave no temporary file.");
            File.WriteAllText(settings, "{\"version\":1,\"x\":-700,\"y\":320,\"width\":220,\"height\":76,\"topmost\":false}", Encoding.UTF8);
            var migrated = new DesktopPetPreferences(directory);
            Check(migrated.Location == new Point(-700, 320) && !migrated.AlwaysOnTop && migrated.PetId == "01", "The old widget position and pin choice must survive the pet upgrade.");
            migrated.SelectPet("10"); Check(new DesktopPetPreferences(directory).PetId == "10", "A migrated file must remain writable in the new format.");
            foreach (string broken in new[] { "{", "null", "{\"version\":3,\"topmost\":false}", "{\"version\":2,\"petId\":\"06\",\"size\":9000,\"motion\":false,\"topmost\":false}", new string('x', 8193) })
            {
                File.WriteAllText(settings, broken, Encoding.UTF8); var recovered = new DesktopPetPreferences(directory);
                Check(recovered.PetId == "01" && recovered.SizePixels == 96 && recovered.AlwaysOnTop && recovered.PersistenceWarning != null, "An invalid preference file must recover fully to defaults.");
            }
            File.WriteAllText(blocker, "owned test fixture"); var blocked = new DesktopPetPreferences(blocker); blocked.SelectPet("04");
            Check(blocked.PetId == "04" && blocked.PersistenceWarning != null, "A failed save must retain the session choice and report the persistence failure.");
            Check(File.ReadAllText(blocker) == "owned test fixture", "Failed persistence must not overwrite a conflicting file.");
        }
        finally
        {
            // Only these known files were created by this test. No recursive cleanup or user data.
            if (File.Exists(settings)) File.Delete(settings); if (File.Exists(blocker)) File.Delete(blocker); Directory.Delete(directory);
        }
        const string account = "11111111-1111-4111-8111-111111111111";
        string accountJson = "{\"enabled\":true,\"activeAccountId\":\"" + account + "\",\"accounts\":[{\"id\":\"" + account + "\",\"login\":\"sample-person\",\"host\":\"https://github.com\",\"status\":\"connected\"}]}";
        var accounts = WidgetAccountSet.Read(DesktopJson.Parse(accountJson));
        Check(accounts.Accounts.Count == 1 && accounts.ActiveId == account, "The menu must preserve the stable profile id.");
        accounts.VerifySnapshot(DesktopJson.Parse("{\"accountId\":\"" + account + "\"}")); assertions++;
        Reject(delegate { accounts.VerifySnapshot(DesktopJson.Parse("{\"accountId\":null}")); }, "A quota from another account must not be paired with the old menu.");
        Reject(delegate { accounts.VerifySnapshot(DesktopJson.Parse("{}")); }, "A missing snapshot identity must not be accepted.");
        Reject(delegate { WidgetAccountSet.Read(DesktopJson.Parse(accountJson.Replace("https://github.com", "https://github.com.invalid"))); }, "Account menu hosts must remain supported GitHub hosts.");
        return assertions;
    }
}
