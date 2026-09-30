using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
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
                using (var animation = DesktopPetCatalog.CreateAnimation(pet.Id))
                {
                    Check(animation.PetId == pet.Id && animation.LayerCount >= 3 && animation.LayerCount <= 10, "Every pet must load its own bounded set of authored layers.");
                    CheckIdleMotion(image, animation, pet.Id);
                    foreach (var kind in new[] { DesktopPetReactionKind.Update, DesktopPetReactionKind.Message, DesktopPetReactionKind.Attention })
                    foreach (int size in new[] { 64, 160 })
                    {
                        float scale = size == 64 ? 2 : 1;
                        using (var still = DesktopPetRenderer.Render(image, size, scale, 0, "收到新消息", false, pet.Id == "10"))
                        using (var start = DesktopPetRenderer.Render(image, size, scale, 0, "收到新消息", false, pet.Id == "10", null, false, -1, animation, kind, 0))
                        using (var middle = DesktopPetRenderer.Render(image, size, scale, 0, "收到新消息", false, pet.Id == "10", null, false, -1, animation, kind, .35))
                        using (var end = DesktopPetRenderer.Render(image, size, scale, 0, "收到新消息", false, pet.Id == "10", null, false, -1, animation, kind, 1))
                        {
                            string original = Digest(still);
                            Check(original == Digest(start) && original == Digest(end), "Pet " + pet.Id + " " + kind + " must begin and settle to the exact original still frame.");
                            Check(original != Digest(middle), "Pet " + pet.Id + " " + kind + " must animate its authored layers between still frames.");
                            Check(middle.GetPixel(0, 0).A == 0 && middle.GetPixel(middle.Width - 1, middle.Height - 1).A == 0, "Animated layers must preserve the transparent desktop surface.");
                        }
                    }
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
            using (var syncStart = DesktopPetRenderer.Render(second, 96, 1, 0, "正在同步…", false, false, null, true))
            using (var syncLater = DesktopPetRenderer.Render(second, 96, 1, .3, "正在同步…", false, false, null, true))
                Check(Digest(syncStart) != Digest(syncLater), "An active sync must visibly move the pet and its indicator.");
            using (var still = DesktopPetRenderer.Render(second, 96, 1, 0, "剩余 59%", false, false))
            using (var updated = DesktopPetRenderer.Render(second, 96, 1, 0, "剩余 59%", false, false, null, false, .35))
            using (var finished = DesktopPetRenderer.Render(second, 96, 1, 0, "剩余 59%", false, false, null, false, 1))
            {
                Check(Digest(still) != Digest(updated), "A changed snapshot must create a short visible bounce and caption pulse.");
                Check(Digest(still) == Digest(finished), "The update animation must settle to the exact still frame.");
            }
        }
        Reject(delegate { DesktopPetCatalog.CreateBitmap("../01"); }, "Resource ids must not accept paths.");
        Reject(delegate { DesktopPetCatalog.CreateAnimation("../01"); }, "Animation resource ids must not accept paths.");
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
        var activity = DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "ready", ActivityKey = "v1:" + new string('a', 64) });
        Check(activity.ActivityKey == "v1:" + new string('a', 64), "A valid bounded activity fingerprint must reach the event engine.");
        foreach (string malformed in new[] { "v1:abc", "v1:" + new string('A', 64), "v1:" + new string('a', 65), "private-session-path", "v1:" + new string('a', 64) + "\n" })
            Check(DesktopWidget.CopySnapshot(new WidgetSnapshot { ActivityKey = malformed }).ActivityKey == null, "Malformed activity metadata must not create a local-usage event.");

        CheckReactionMotion();
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
        Check(WidgetAccountSet.Read(DesktopJson.Parse(accountJson.Replace("\"enabled\":true", "\"enabled\":true,\"refreshing\":true"))).Refreshing, "Native polling must retain the provider refresh state for sync motion.");
        Reject(delegate { WidgetAccountSet.Read(DesktopJson.Parse(accountJson.Replace("\"enabled\":true", "\"enabled\":true,\"refreshing\":\"yes\""))); }, "Malformed refresh state must not create an endless sync indicator.");
        accounts.VerifySnapshot(DesktopJson.Parse("{\"accountId\":\"" + account + "\"}")); assertions++;
        Reject(delegate { accounts.VerifySnapshot(DesktopJson.Parse("{\"accountId\":null}")); }, "A quota from another account must not be paired with the old menu.");
        Reject(delegate { accounts.VerifySnapshot(DesktopJson.Parse("{}")); }, "A missing snapshot identity must not be accepted.");
        Reject(delegate { WidgetAccountSet.Read(DesktopJson.Parse(accountJson.Replace("https://github.com", "https://github.com.invalid"))); }, "Account menu hosts must remain supported GitHub hosts.");
        return assertions;
    }

    // Ignore invisible RGB and tiny antialiasing changes: an animated joint
    // must move a visible group of pixels, not merely produce a new PNG hash.
    private static int DifferentPixels(Bitmap first, Bitmap second)
    {
        if (first.Size != second.Size) throw new ArgumentException("Frame sizes must match.");
        var bounds = new Rectangle(Point.Empty, first.Size);
        var before = first.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var after = second.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int changed = 0;
            var left = new byte[first.Width * 4]; var right = new byte[first.Width * 4];
            for (int y = 0; y < first.Height; y++)
            {
                Marshal.Copy(IntPtr.Add(before.Scan0, y * before.Stride), left, 0, left.Length);
                Marshal.Copy(IntPtr.Add(after.Scan0, y * after.Stride), right, 0, right.Length);
                for (int x = 0; x < left.Length; x += 4)
                {
                    int alphaLeft = left[x + 3], alphaRight = right[x + 3];
                    if (Math.Max(alphaLeft, alphaRight) < 32) continue;
                    int difference = Math.Abs(alphaLeft - alphaRight);
                    for (int channel = 0; channel < 3; channel++)
                        difference += Math.Abs(left[x + channel] * alphaLeft / 255 - right[x + channel] * alphaRight / 255);
                    if (difference >= 32) changed++;
                }
            }
            return changed;
        }
        finally { first.UnlockBits(before); second.UnlockBits(after); }
    }

    private static bool TransparentCorners(Bitmap frame)
    {
        return frame.GetPixel(0, 0).A == 0 && frame.GetPixel(frame.Width - 1, 0).A == 0
            && frame.GetPixel(0, frame.Height - 1).A == 0 && frame.GetPixel(frame.Width - 1, frame.Height - 1).A == 0;
    }

    private static void CheckIdleMotion(Bitmap image, DesktopPetAnimation animation, string petId)
    {
        bool pixelArt = petId == "10";
        const string caption = "收到新消息";
        foreach (int size in new[] { 64, 160 })
        {
            float scale = size == 64 ? 2 : 1;
            int minimum = (int)(size * scale * size * scale / 200); // 0.5% of the pet's rendered area.
            int independentMovement = 0, authoredMovement = 0;
            foreach (double phase in new[] { 0.0, .35, .7, 1.1 })
            {
                // These phases have the same sine, hence identical old-style
                // breathing. Different authored frames prove limb/pose motion.
                double partner = Math.PI - phase;
                using (var generic = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt))
                using (var genericPartner = DesktopPetRenderer.Render(image, size, scale, partner, caption, false, pixelArt))
                using (var idle = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, DesktopPetReactionKind.None, -1, true))
                using (var idlePartner = DesktopPetRenderer.Render(image, size, scale, partner, caption, false, pixelArt, null, false, -1, animation, DesktopPetReactionKind.None, -1, true))
                using (var idleOff = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, DesktopPetReactionKind.None, -1, false))
                {
                    Check(Digest(generic) == Digest(genericPartner), "The phase pair must keep generic breathing identical for pet " + petId + ".");
                    Check(Digest(generic) == Digest(idleOff), "Disabling authored idle motion must retain the exact legacy render for pet " + petId + ".");
                    independentMovement = Math.Max(independentMovement, DifferentPixels(idle, idlePartner));
                    authoredMovement = Math.Max(authoredMovement, DifferentPixels(generic, idle));
                    Check(TransparentCorners(idle) && TransparentCorners(idlePartner), "Idle poses must retain transparent corners for pet " + petId + ".");
                }
            }
            Check(independentMovement >= minimum, "Pet " + petId + " idle must move visible authored parts independently of generic breathing; changed " + independentMovement + " pixels, required " + minimum + ".");
            Check(authoredMovement >= minimum, "Pet " + petId + " idle must visibly differ from the old whole-image breathing render.");

            foreach (double phase in new[] { .7, 4.2 })
            foreach (var kind in new[] { DesktopPetReactionKind.Update, DesktopPetReactionKind.Message, DesktopPetReactionKind.Attention })
            using (var idle = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, DesktopPetReactionKind.None, -1, true))
            using (var start = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, kind, 0, true))
            using (var nearStart = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, kind, .001, true))
            using (var middle = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, kind, .35, true))
            using (var nearEnd = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, kind, .999, true))
            using (var end = DesktopPetRenderer.Render(image, size, scale, phase, caption, false, pixelArt, null, false, -1, animation, kind, 1, true))
            {
                string baseline = Digest(idle);
                Check(baseline == Digest(start) && baseline == Digest(end), "Pet " + petId + " " + kind + " must enter and leave the current idle pose without resetting its phase.");
                Check(DifferentPixels(idle, middle) >= minimum, "Pet " + petId + " " + kind + " must remain visibly stronger than same-phase idle movement.");
                Check(DifferentPixels(idle, nearStart) <= minimum / 10 && DifferentPixels(idle, nearEnd) <= minimum / 10,
                    "Pet " + petId + " " + kind + " must approach idle smoothly at both event boundaries.");
                Check(TransparentCorners(start) && TransparentCorners(middle) && TransparentCorners(end), "Pet " + petId + " event-over-idle frames must preserve the transparent desktop surface.");
            }
        }
    }

    private static void CheckReactionMotion()
    {
        const long duration = WidgetUpdateMotion.Duration;
        var beforeUpdate = DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "ready", AccountId = "account-a", InstanceId = "service-a", QuotaKey = "premium", Title = "个人额度", Value = "60 剩余", Percentage = 40, ActivityKey = "v1:" + new string('a', 64) });
        var changed = DesktopWidget.CopySnapshot(beforeUpdate); changed.Value = "59 剩余"; changed.Percentage = 41;
        var same = DesktopWidget.CopySnapshot(changed); same.UpdatedAt = "later";
        var motion = new WidgetUpdateMotion();
        motion.Observe(beforeUpdate, 0, false);
        Check(motion.Kind(100) == DesktopPetReactionKind.None && motion.Progress(100) < 0, "The first snapshot must appear without pretending it is an update.");
        motion.Observe(changed, 100, false);
        Check(motion.Kind(300) == DesktopPetReactionKind.Update && motion.Progress(300) > 0 && motion.Progress(300) < 1, "A confirmed quota change within the same account and category must animate.");
        Check(motion.Caption(300) == "额度已更新", "A quota change needs the quota update caption.");
        motion.Observe(same, 400, false);
        Check(motion.Progress(100 + duration / 2) == .5, "An unchanged poll or new timestamp must not restart the animation.");
        Check(motion.Progress(100 + duration) < 0 && motion.Kind(100 + duration) == DesktopPetReactionKind.None, "A quiet poll must not extend the completed animation.");

        motion = new WidgetUpdateMotion(); motion.Observe(beforeUpdate, 0, false); motion.Observe(changed, 100, false);
        motion.Observe(DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "loading" }), 200, true);
        Check(motion.Progress(250) < 0, "Starting synchronization must stop a previous update pulse.");
        var synced = DesktopWidget.CopySnapshot(changed); synced.Value = "58 剩余";
        motion.Observe(synced, 400, false);
        Check(motion.Kind(500) == DesktopPetReactionKind.Update, "A loading interval must preserve the same-account baseline for the completed refresh.");
        foreach (string boundary in new[] { "account", "service", "category", "title", "unit" })
        {
            motion = new WidgetUpdateMotion(); motion.Observe(beforeUpdate, 0, false);
            var other = DesktopWidget.CopySnapshot(changed);
            if (boundary == "account") other.AccountId = "account-b";
            if (boundary == "service") other.InstanceId = "service-b";
            if (boundary == "category") other.QuotaKey = "chat";
            if (boundary == "title") other.Title = "本机记录";
            if (boundary == "unit") other.UnitLabel = "AI Credits";
            motion.Observe(other, 100, false);
            Check(motion.Progress(200) < 0, "Changing " + boundary + " must establish a new baseline instead of celebrating incomparable quotas.");
        }

        foreach (string state in new[] { "ready", "waiting" })
        {
            motion = new WidgetUpdateMotion();
            var localBefore = DesktopWidget.CopySnapshot(beforeUpdate); localBefore.State = state;
            var localAfter = DesktopWidget.CopySnapshot(localBefore); localAfter.ActivityKey = "v1:" + new string('b', 64);
            motion.Observe(localBefore, 0, false); motion.Observe(localAfter, 100, false);
            Check(motion.Kind(200) == DesktopPetReactionKind.Update && motion.Caption(200) == "收到新的用量记录", "Local usage must animate while the quota remains unchanged or unavailable.");
            var localPoll = DesktopWidget.CopySnapshot(localAfter); localPoll.UpdatedAt = "later";
            motion.Observe(localPoll, 400, false);
            Check(motion.Progress(100 + duration / 2) == .5, "Unchanged " + state + " activity polls must neither restart nor truncate an in-flight gesture.");
            Check(motion.Kind(100 + duration) == DesktopPetReactionKind.None, "One local activity change must end without replaying on a quiet poll.");
        }
        foreach (string boundary in new[] { "account", "service" })
        {
            motion = new WidgetUpdateMotion(); motion.Observe(beforeUpdate, 0, false);
            var other = DesktopWidget.CopySnapshot(beforeUpdate); other.ActivityKey = "v1:" + new string('b', 64);
            if (boundary == "account") other.AccountId = "account-b"; else other.InstanceId = "service-b";
            motion.Observe(other, 100, false);
            Check(motion.Kind(200) == DesktopPetReactionKind.None, "New activity metadata after a " + boundary + " change must establish a quiet baseline.");
        }
        motion = new WidgetUpdateMotion();
        var legacy = DesktopWidget.CopySnapshot(beforeUpdate); legacy.ActivityKey = null;
        motion.Observe(legacy, 0, false); motion.Observe(beforeUpdate, 100, false);
        Check(motion.Kind(200) == DesktopPetReactionKind.None, "Receiving activity metadata for the first time must remain quiet.");

        foreach (string state in new[] { "error", "offline", "reauth", "needs-login" })
        {
            motion = new WidgetUpdateMotion(); motion.Observe(beforeUpdate, 0, false); motion.Observe(changed, 100, false);
            var failure = DesktopWidget.CopySnapshot(new WidgetSnapshot { State = state, AccountId = "account-a", InstanceId = "service-a", Refreshing = true });
            motion.Observe(failure, 200, false);
            Check(motion.Kind(300) == DesktopPetReactionKind.Attention && !WidgetUpdateMotion.IsSyncing(failure, true), "A " + state + " transition must replace update motion with one attention gesture and stop syncing.");
            motion.Observe(failure, 400, false);
            Check(motion.Progress(200 + duration / 2) == .5, "Repeated " + state + " polls must not restart an attention gesture.");
            motion.Observe(changed, 200 + duration, false);
            Check(motion.Kind(200 + duration) == DesktopPetReactionKind.None, "Recovery must not compare against an invalidated quota or replay the old failure.");
        }
        motion = new WidgetUpdateMotion();
        motion.Observe(DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "needs-login", InstanceId = "service-a" }), 0, false);
        Check(motion.Kind(100) == DesktopPetReactionKind.None, "A first run without an account must stay quiet instead of implying expired authorization.");
        var pendingSync = DesktopWidget.CopySnapshot(changed); pendingSync.Refreshing = true;
        Check(WidgetUpdateMotion.IsSyncing(pendingSync, false) && WidgetUpdateMotion.IsSyncing(changed, true), "Provider refreshes and immediate user refresh requests must both show syncing.");
        Check(!WidgetUpdateMotion.IsSyncing(DesktopWidget.CopySnapshot(new WidgetSnapshot { State = "waiting" }), false), "An idle unknown quota must not spin forever.");

        motion = new WidgetUpdateMotion();
        motion.Notify(DesktopPetReactionKind.Update, "usage-1", "用量更新", 0);
        for (int index = 2; index <= 20; index++) motion.Notify(DesktopPetReactionKind.Update, "usage-" + index, "用量更新", index * 10);
        Check(motion.Progress(duration / 2) == .5 && motion.Caption(duration / 2) == "用量更新", "Update bursts must coalesce without restarting the active gesture.");
        Check(motion.Kind(duration) == DesktopPetReactionKind.None, "Update bursts must not accumulate an unbounded animation queue.");
        motion.Notify(DesktopPetReactionKind.Message, "usage-1", "重复事件", duration + 1);
        Check(motion.Kind(duration + 1) == DesktopPetReactionKind.None, "An already-observed event id must not replay after its animation ends.");

        motion = new WidgetUpdateMotion();
        motion.Notify(DesktopPetReactionKind.None, "ignored", "忽略", 0);
        motion.Notify(DesktopPetReactionKind.Message, null, "忽略", 0);
        motion.Notify(DesktopPetReactionKind.Message, "", "忽略", 0);
        Check(motion.Kind(0) == DesktopPetReactionKind.None, "Missing event identity and no-reaction notices must remain quiet.");
        motion.Notify(DesktopPetReactionKind.Update, "update", "用量更新", 0);
        motion.Notify(DesktopPetReactionKind.Message, "message", "同步完成", 100);
        Check(motion.Kind(200) == DesktopPetReactionKind.Message && motion.Caption(200) == "同步完成", "An internal message must take priority over a quota update.");
        motion.Notify(DesktopPetReactionKind.Attention, "attention", "登录过期", 300);
        motion.Notify(DesktopPetReactionKind.Update, "late-update", "用量更新", 400);
        motion.Notify(DesktopPetReactionKind.Message, "message-old", "旧通知", 500);
        motion.Notify(DesktopPetReactionKind.Message, "message-new", "会话结束", 600);
        Check(motion.Kind(700) == DesktopPetReactionKind.Attention && motion.Caption(700) == "登录过期", "An attention gesture must not be displaced by later lower-priority activity.");
        Check(motion.Kind(300 + duration) == DesktopPetReactionKind.Message && motion.Caption(300 + duration) == "会话结束", "Only the most recent pending message should play after attention.");
        Check(motion.Kind(300 + duration * 2) == DesktopPetReactionKind.None, "A notification burst may retain at most one pending notice.");

        motion = new WidgetUpdateMotion();
        motion.Notify(DesktopPetReactionKind.Message, "caption", "首行\r\n" + new string('长', 100), 0);
        Check(motion.Caption(0).Length <= 80 && !motion.Caption(0).Contains("\n") && !motion.Caption(0).Contains("\r"), "Event captions must remain bounded and single-line.");
        motion.Notify(DesktopPetReactionKind.Message, "pending", "等待通知", 100);
        motion.Clear();
        Check(motion.Kind(200) == DesktopPetReactionKind.None && motion.Caption(200) == null && motion.Progress(200) < 0, "Clear must stop the current gesture and discard its pending notice.");
        Check(motion.Kind(duration * 3) == DesktopPetReactionKind.None, "Cleared notices must not reappear later.");
        motion.Notify(DesktopPetReactionKind.Message, "pending", "重复通知", duration * 3 + 1);
        Check(motion.Kind(duration * 3 + 1) == DesktopPetReactionKind.None, "Clearing visible animation must retain event deduplication.");

        motion = new WidgetUpdateMotion();
        for (int index = 0; index < 65; index++)
        {
            motion.Notify(DesktopPetReactionKind.Update, "bounded-" + index, "用量更新", index * (duration + 1));
            motion.Clear();
        }
        motion.Notify(DesktopPetReactionKind.Message, "bounded-64", "仍记得", duration * 100);
        Check(motion.Kind(duration * 100) == DesktopPetReactionKind.None, "The latest event identity must stay deduplicated.");
        motion.Notify(DesktopPetReactionKind.Message, "bounded-0", "较早事件", duration * 100 + 1);
        Check(motion.Kind(duration * 100 + 1) == DesktopPetReactionKind.Message, "The event identity cache must evict old entries after its bounded history fills.");
    }
}
