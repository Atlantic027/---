using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Security;

internal static class WlanHelper {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct InterfaceInfo {
        public Guid id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string description;
        public uint state;
    }
    [StructLayout(LayoutKind.Sequential)] struct Ssid {
        public uint length;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst=32)] public byte[] bytes;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Network {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string profile;
        public Ssid ssid;
        public uint bssType, bssidCount;
        [MarshalAs(UnmanagedType.Bool)] public bool connectable;
        public uint reason, phyCount;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst=8)] public uint[] phyTypes;
        [MarshalAs(UnmanagedType.Bool)] public bool morePhy;
        public uint signal;
        [MarshalAs(UnmanagedType.Bool)] public bool secure;
        public uint auth, cipher, flags, reserved;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Connection {
        public uint mode;
        [MarshalAs(UnmanagedType.LPWStr)] public string profile;
        public IntPtr ssid, bssidList;
        public uint bssType, flags;
    }
    [DllImport("wlanapi.dll")] static extern uint WlanOpenHandle(uint version, IntPtr reserved, out uint negotiated, out IntPtr handle);
    [DllImport("wlanapi.dll")] static extern uint WlanCloseHandle(IntPtr handle, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern uint WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr memory);
    [DllImport("wlanapi.dll")] static extern uint WlanScan(IntPtr handle, ref Guid id, IntPtr ssid, IntPtr ie, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern uint WlanGetAvailableNetworkList(IntPtr handle, ref Guid id, uint flags, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll", CharSet=CharSet.Unicode)] static extern uint WlanConnect(IntPtr handle, ref Guid id, ref Connection parameters, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern uint WlanQueryInterface(IntPtr handle, ref Guid id, uint opcode, IntPtr reserved, out uint size, out IntPtr data, out uint type);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static string Text(Dictionary<string,object> request, string key) { object value; return request.TryGetValue(key, out value) ? value as string : null; }
    static void Check(uint code) { if (code != 0) throw new NativeError(code); }
    sealed class NativeError : Exception { public uint Code; public NativeError(uint code) { Code=code; } }
    static List<InterfaceInfo> Interfaces(IntPtr handle) {
        IntPtr memory; Check(WlanEnumInterfaces(handle, IntPtr.Zero, out memory));
        try {
            var result = new List<InterfaceInfo>(); int count = Marshal.ReadInt32(memory);
            for(int i=0;i<count;i++) result.Add((InterfaceInfo)Marshal.PtrToStructure(IntPtr.Add(memory, 8+i*Marshal.SizeOf(typeof(InterfaceInfo))), typeof(InterfaceInfo)));
            return result;
        } finally { WlanFreeMemory(memory); }
    }
    static List<Network> Networks(IntPtr handle, Guid id) {
        IntPtr memory; Check(WlanGetAvailableNetworkList(handle, ref id, 0, IntPtr.Zero, out memory));
        try {
            var result=new List<Network>(); int count=Marshal.ReadInt32(memory);
            for(int i=0;i<count;i++) result.Add((Network)Marshal.PtrToStructure(IntPtr.Add(memory,8+i*Marshal.SizeOf(typeof(Network))),typeof(Network)));
            return result;
        } finally { WlanFreeMemory(memory); }
    }
    static string Name(Network network) { return new UTF8Encoding(false,true).GetString(network.ssid.bytes,0,(int)Math.Min(network.ssid.length,32)); }
    static string Security(Network network) { return !network.secure && network.auth==1 ? "open" : network.auth==7 && network.cipher==4 ? "wpa2-personal" : "unsupported"; }
    static object Scan(IntPtr handle) {
        var interfaces=Interfaces(handle); var results=new List<object>(); var errors=new List<object>();
        foreach(var item in interfaces) { Guid id=item.id; uint code=WlanScan(handle,ref id,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero); if(code!=0) errors.Add(new {interfaceId=id.ToString(),nativeCode=code}); }
        if(interfaces.Count>0) Thread.Sleep(2500);
        foreach(var item in interfaces) {
            try {
                foreach(var network in Networks(handle,item.id)) {
                    string ssid; try { ssid=Name(network); } catch { continue; }
                    if(ssid.Length==0) continue;
                    results.Add(new {interfaceId=item.id.ToString(),interfaceName=item.description,ssid=ssid,signal=network.signal,security=Security(network),connected=(network.flags&1)!=0,connectable=network.connectable});
                }
            } catch(NativeError error) { errors.Add(new {interfaceId=item.id.ToString(),nativeCode=error.Code}); }
        }
        return new {ok=errors.Count==0 && interfaces.Count>0,networks=results,errors=errors,error=interfaces.Count==0?"NO_WLAN_INTERFACE":errors.Count>0?"WLAN_SCAN_FAILED":null};
    }
    static string Escape(string text) { return SecurityElement.Escape(text); }
    static bool IsConnected(IntPtr handle, Guid id, byte[] desired) {
        uint size,type; IntPtr data; uint code=WlanQueryInterface(handle,ref id,7,IntPtr.Zero,out size,out data,out type);
        if(code!=0) return false;
        try {
            // WLAN_CONNECTION_ATTRIBUTES: state(4), mode(4), profile WCHAR[256], association SSID.
            if(size<556 || Marshal.ReadInt32(data)!=1 || Marshal.ReadInt32(data,520)!=desired.Length) return false;
            for(int i=0;i<desired.Length;i++) if(Marshal.ReadByte(data,524+i)!=desired[i]) return false;
            return true;
        } finally { WlanFreeMemory(data); }
    }
    static object Connect(IntPtr handle, Dictionary<string,object> request) {
        Guid id; string ssid=Text(request,"ssid"),password=Text(request,"password"),security=Text(request,"security");
        if(!Guid.TryParse(Text(request,"interfaceId"),out id) || ssid==null || password==null || ssid.Length==0 || Encoding.UTF8.GetByteCount(ssid)>32) throw new Exception();
        foreach(char c in ssid) if(char.IsControl(c)) throw new Exception();
        if(security!="open" && security!="wpa2-personal") throw new Exception();
        if(security=="open" ? password.Length!=0 : password.Length<8 || password.Length>63) throw new Exception();
        foreach(char c in password) if(c<32 || c>126) throw new Exception();
        bool found=false;
        foreach(var network in Networks(handle,id)) if(Name(network)==ssid && Security(network)==security && network.connectable) found=true;
        if(!found) return new {ok=false,error="NETWORK_NOT_AVAILABLE_OR_UNSUPPORTED"};
        byte[] bytes=Encoding.UTF8.GetBytes(ssid);
        string hex=BitConverter.ToString(bytes).Replace("-","");
        string auth=security=="open"?"open":"WPA2PSK", encryption=security=="open"?"none":"AES";
        string key=security=="open"?"":"<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>"+Escape(password)+"</keyMaterial></sharedKey>";
        string xml="<?xml version=\"1.0\"?><WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\"><name>MAX35-Temporary</name><SSIDConfig><SSID><hex>"+hex+"</hex><name>"+Escape(ssid)+"</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security><authEncryption><authentication>"+auth+"</authentication><encryption>"+encryption+"</encryption><useOneX>false</useOneX></authEncryption>"+key+"</security></MSM></WLANProfile>";
        // wlan_connection_mode_temporary_profile = 1: XML stays in memory, no saved profile.
        var parameters=new Connection {mode=1,profile=xml,ssid=IntPtr.Zero,bssidList=IntPtr.Zero,bssType=1,flags=0};
        Check(WlanConnect(handle,ref id,ref parameters,IntPtr.Zero));
        for(int i=0;i<40;i++) { Thread.Sleep(500); if(IsConnected(handle,id,bytes)) return new {ok=true,connected=true,ssid=ssid,interfaceId=id.ToString()}; }
        return new {ok=false,error="CONNECTION_NOT_CONFIRMED"};
    }
    public static void Main() {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        IntPtr handle=IntPtr.Zero;
        object result;
        try {
            char[] input=new char[8193]; int total=0,read;
            while(total<input.Length && (read=Console.In.Read(input,total,input.Length-total))>0) total+=read;
            if(total>8192) throw new Exception();
            var request=Json.Deserialize<Dictionary<string,object>>(new string(input,0,total)); Array.Clear(input,0,input.Length);
            uint version; Check(WlanOpenHandle(2,IntPtr.Zero,out version,out handle));
            string action=Text(request,"action");
            if(action=="scan") result=Scan(handle); else if(action=="connect") result=Connect(handle,request); else throw new Exception();
        } catch(NativeError error) { result=new {ok=false,error="WLAN_ERROR",nativeCode=error.Code}; }
          catch { result=new {ok=false,error="INVALID_REQUEST_OR_NATIVE_FAILURE"}; }
        finally { if(handle!=IntPtr.Zero) WlanCloseHandle(handle,IntPtr.Zero); }
        Console.Write(Json.Serialize(result));
    }
}
