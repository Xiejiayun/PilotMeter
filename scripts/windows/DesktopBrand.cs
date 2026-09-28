using System.Drawing;
using System.IO;
using System.Reflection;

internal static class DesktopBrand
{
    // Each caller owns its icon, independently of the resource stream and other windows.
    internal static Icon CreateIcon()
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PilotMeter.Icon"))
        {
            // Windowless contract tests compile these sources without application resources.
            if (stream == null) return (Icon)SystemIcons.Application.Clone();
            using (Icon icon = new Icon(stream)) return (Icon)icon.Clone();
        }
    }
}
