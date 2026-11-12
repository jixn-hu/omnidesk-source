using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

sealed class ImportTypeLibrary : ITypeLibImporterNotifySink {
    [DllImport("oleaut32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void LoadTypeLibEx(string file, int kind, out ITypeLib typeLib);

    public void ReportEvent(ImporterEventKind kind, int code, string message) { }
    public Assembly ResolveRef(object typeLib) { throw new InvalidOperationException("Unexpected RDP type library dependency"); }

    static void Main(string[] arguments) {
        ITypeLib typeLib;
        LoadTypeLibEx(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "mstscax.dll"), 2, out typeLib);
        string destination = Path.Combine(Path.GetFullPath(arguments[0]), "Interop.MSTSCLib.dll");
        AssemblyBuilder assembly = new TypeLibConverter().ConvertTypeLibToAssembly(typeLib, destination,
            TypeLibImporterFlags.None, new ImportTypeLibrary(), null, null, "MSTSCLib", null);
        assembly.Save(Path.GetFileName(destination));
    }
}
