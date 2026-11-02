// Isekai Áudio: captura o som de UM programa (player, navegador, jogo) e entrega para o Isekai pela saída padrão.
// Usa a captura por processo do Windows 10 2004+ (a mesma ideia do Discord), então a voz da call não vaza.
// Escrito em C# 5 para compilar com o csc que já vem no Windows (.NET Framework 4.8).
//   IsekaiAudio.exe list         -> JSON com os programas que têm janela aberta
//   IsekaiAudio.exe capture PID  -> PCM 16 bits, 48 kHz, estéreo na saída até a entrada fechar
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace IsekaiAudio
{
    static class Program
    {
        static int Main(string[] args)
        {
            if (args.Length >= 1 && args[0] == "list")
            {
                var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                stdout.Write(AppsJson(args.Length >= 2 ? args[1] : ""));
                stdout.Flush();
                return 0;
            }
            int pid;
            if (args.Length >= 2 && args[0] == "capture" && int.TryParse(args[1], out pid))
            {
                var output = Console.OpenStandardOutput();
                var gate = new object();
                Capture capture;
                try
                {
                    capture = new Capture(pid, (buffer, count) =>
                    {
                        lock (gate)
                        {
                            try { output.Write(buffer, 0, count); output.Flush(); }
                            catch { Environment.Exit(0); }
                        }
                    });
                    capture.Start();
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(ex.Message);
                    return 2;
                }
                // O Isekai fecha a entrada (ou mata o processo) quando a transmissão para.
                try { Console.OpenStandardInput().Read(new byte[1], 0, 1); } catch { }
                capture.Stop();
                return 0;
            }
            Console.Error.WriteLine("uso: IsekaiAudio list | IsekaiAudio capture PID");
            return 1;
        }

        // Programas com janela aberta: é onde estão os players, navegadores e jogos.
        static string AppsJson(string skipPids)
        {
            var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
                "explorer", "TextInputHost", "ApplicationFrameHost", "SystemSettings", "IsekaiAudio", "ShellExperienceHost",
            };
            var skipIds = new HashSet<int>();
            foreach (var s in skipPids.Split(',')) { int id; if (int.TryParse(s, out id)) skipIds.Add(id); }
            var items = new List<string>();
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (skipIds.Contains(p.Id) || p.MainWindowHandle == IntPtr.Zero || string.IsNullOrEmpty(p.MainWindowTitle) || skip.Contains(p.ProcessName)) continue;
                    items.Add("{\"pid\":" + p.Id + ",\"name\":" + Quote(p.ProcessName) + ",\"title\":" + Quote(p.MainWindowTitle) + "}");
                }
                catch { }
            }
            return "[" + string.Join(",", items) + "]";
        }

        static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }
    }

    // Captura o áudio de um processo (e dos filhos dele) em PCM 16 bits, 48 kHz, estéreo.
    class Capture
    {
        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

        readonly int pid;
        readonly Action<byte[], int> sink;
        IAudioClient client;
        IAudioCaptureClient captureClient;
        EventWaitHandle ready;
        Thread thread;
        volatile bool running;

        public Capture(int pid, Action<byte[], int> sink)
        {
            this.pid = pid;
            this.sink = sink;
        }

        public void Start()
        {
            client = Activate(pid);
            var format = new WAVEFORMATEX { wFormatTag = 1, nChannels = 2, nSamplesPerSec = 48000, nAvgBytesPerSec = 192000, nBlockAlign = 4, wBitsPerSample = 16, cbSize = 0 };
            IntPtr pFormat = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WAVEFORMATEX)));
            try
            {
                Marshal.StructureToPtr(format, pFormat, false);
                client.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    200000, 0, pFormat, IntPtr.Zero);
            }
            finally { Marshal.FreeHGlobal(pFormat); }

            ready = new EventWaitHandle(false, EventResetMode.AutoReset);
            client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
            Guid iid = typeof(IAudioCaptureClient).GUID;
            object service;
            client.GetService(ref iid, out service);
            captureClient = (IAudioCaptureClient)service;
            client.Start();
            running = true;
            thread = new Thread(Loop) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
            thread.Start();
        }

        void Loop()
        {
            var buffer = new byte[48000 * 4];
            while (running)
            {
                ready.WaitOne(100);
                uint packet;
                while (running && captureClient.GetNextPacketSize(out packet) == 0 && packet > 0)
                {
                    IntPtr data;
                    uint frames, flags;
                    ulong devicePosition, qpcPosition;
                    if (captureClient.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition) != 0) break;
                    int bytes = Math.Min((int)frames * 4, buffer.Length);
                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(buffer, 0, bytes);
                    else Marshal.Copy(data, buffer, 0, bytes);
                    captureClient.ReleaseBuffer(frames);
                    sink(buffer, bytes);
                }
            }
        }

        public void Stop()
        {
            running = false;
            if (thread != null) thread.Join(500);
            try { client.Stop(); } catch { }
            if (captureClient != null) Marshal.ReleaseComObject(captureClient);
            if (client != null) Marshal.ReleaseComObject(client);
            if (ready != null) ready.Dispose();
        }

        static IAudioClient Activate(int pid)
        {
            var parameters = new AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType = 1 /* PROCESS_LOOPBACK */, TargetProcessId = (uint)pid, ProcessLoopbackMode = 0 /* incluir a árvore do processo */ };
            int size = Marshal.SizeOf(typeof(AUDIOCLIENT_ACTIVATION_PARAMS));
            IntPtr pParams = Marshal.AllocHGlobal(size);
            // PROPVARIANT com VT_BLOB: vt no início, BLOB { cbSize; pBlobData } a partir do byte 8.
            int propSize = 8 + 2 * IntPtr.Size;
            IntPtr pVariant = Marshal.AllocHGlobal(propSize);
            try
            {
                Marshal.StructureToPtr(parameters, pParams, false);
                for (int i = 0; i < propSize; i++) Marshal.WriteByte(pVariant, i, 0);
                Marshal.WriteInt16(pVariant, 0, 65 /* VT_BLOB */);
                Marshal.WriteInt32(pVariant, 8, size);
                Marshal.WriteIntPtr(pVariant, 8 + IntPtr.Size, pParams);

                var handler = new ActivationHandler();
                IActivateAudioInterfaceAsyncOperation operation;
                NativeMethods.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, pVariant, handler, out operation);
                if (!handler.Done.WaitOne(5000)) throw new TimeoutException("O Windows não respondeu ao pedido de áudio.");
                int hr;
                object activated;
                operation.GetActivateResult(out hr, out activated);
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                return (IAudioClient)activated;
            }
            finally
            {
                Marshal.FreeHGlobal(pVariant);
                Marshal.FreeHGlobal(pParams);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        void GetBufferSize(out uint bufferFrames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint paddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closestMatch);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr eventHandle);
        void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    // Marca o callback como livre de apartment: o Windows chama ele de outra thread.
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { Done.Set(); }
    }

    static class NativeMethods
    {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        public static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);
    }
}
