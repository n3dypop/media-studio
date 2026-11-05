# Read-only DXGI adapter identity; no driver or device state is changed.
# Vtable layout and DXGI_ADAPTER_DESC1 follow the installed Windows SDK dxgi.h.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class StudioGpuAdapters {
  [StructLayout(LayoutKind.Sequential)] public struct Luid { public UInt32 Low; public Int32 High; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Desc {
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string Description;
    public UInt32 VendorId,DeviceId,SubSysId,Revision;
    public UIntPtr DedicatedVideoMemory,DedicatedSystemMemory,SharedSystemMemory;
    public Luid AdapterLuid; public UInt32 Flags;
  }
  public class Adapter { public string adapterKey; public string description; public UInt32 vendorId; public UInt64 dedicatedBytes; public bool software; }
  [DllImport("dxgi.dll",ExactSpelling=true)] private static extern int CreateDXGIFactory1(ref Guid iid,out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Enumerate(IntPtr self,UInt32 index,out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Describe(IntPtr self,out Desc desc);
  public static Adapter[] Read() {
    var iid=new Guid("770aae78-f26f-4dba-a829-253c83d1b387");IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid,out factory));
    var rows=new List<Adapter>();
    try {
      var enumerate=(Enumerate)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(factory),12*IntPtr.Size),typeof(Enumerate));
      for(UInt32 index=0;index<32;index++) {
        IntPtr adapter;int status=enumerate(factory,index,out adapter);
        if(status==unchecked((int)0x887A0002))break;Marshal.ThrowExceptionForHR(status);
        try {
          var describe=(Describe)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(adapter),10*IntPtr.Size),typeof(Describe));
          Desc desc;Marshal.ThrowExceptionForHR(describe(adapter,out desc));
          rows.Add(new Adapter { adapterKey=unchecked((UInt32)desc.AdapterLuid.High).ToString("x8")+":"+desc.AdapterLuid.Low.ToString("x8")+":0",description=desc.Description,vendorId=desc.VendorId,dedicatedBytes=desc.DedicatedVideoMemory.ToUInt64(),software=(desc.Flags&2)!=0 });
        } finally { Marshal.Release(adapter); }
      }
    } finally { Marshal.Release(factory); }
    return rows.ToArray();
  }
}
'@
@([StudioGpuAdapters]::Read()) | ConvertTo-Json -Compress
