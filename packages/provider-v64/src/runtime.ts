export interface V64Image {
  readonly url: string;
  readonly size?: number;
  readonly async?: boolean;
  readonly disk_option?: 'read_only' | 'read_write';
}

export interface V64NetworkDevice {
  readonly type?: 'virtio' | 'ne2k' | 'e1000' | 'none';
  readonly relay_url?: string;
  readonly plugin_path?: string;
}

export interface V64Options {
  readonly wasm_path: string;
  readonly wasm_fallback_path: string;
  readonly cpu_worker: boolean;
  readonly cpu_worker_url: string;
  readonly parallel: 'auto' | false;
  readonly parallel_wasm_path: string;
  readonly vcpu_worker_url: string;
  readonly cpu_type: 'x86_64';
  readonly cpu_cores: number;
  readonly experimental_smp_jit: boolean;
  readonly machine_type: 'i440fx' | 'q35';
  readonly graphics_adapter: 'bochs_vga' | 'vmware_svga' | 'virtio_gpu';
  readonly graphics_adapter_path: string;
  readonly graphics_proxy?: boolean;
  readonly memory_size: number;
  readonly extended_memory_size?: number;
  readonly vram_size: number;
  readonly bios: V64Image;
  readonly vga_bios: V64Image;
  readonly screen: { readonly container: HTMLElement };
  readonly serial_console: {
    readonly type: 'textarea';
    readonly container: HTMLTextAreaElement;
  };
  readonly acpi: boolean;
  readonly audio_device: 'hd_audio' | 'none';
  readonly audio_device_path?: string;
  readonly net_device?: V64NetworkDevice;
  readonly hda?: V64Image;
  readonly cdrom?: V64Image;
  readonly bzimage?: V64Image;
  readonly initrd?: V64Image;
  readonly cmdline?: string;
  readonly boot_order?: number;
  readonly autostart: false;
}

export interface V64Runtime {
  add_listener(event: string, listener: (argument: never) => void): void;
  remove_listener(event: string, listener: (argument: never) => void): void;
  run(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  keyboard_send_scancodes(scancodes: readonly number[]): Promise<void>;
}

type V64Constructor = new (options: V64Options) => V64Runtime;

interface V64Module {
  readonly V86: V64Constructor;
}

let runtimePromise: Promise<V64Module> | null = null;
let webGpuPromise: Promise<void> | null = null;

/** Kept out of the initial application bundle. */
export function loadV64Runtime(): Promise<V64Module> {
  if (runtimePromise !== null) return runtimePromise;
  runtimePromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('v64 requires a browser document.'));
      return;
    }
    const scope = globalThis as typeof globalThis & {
      __lumibootV64Resolve?: (module: V64Module) => void;
    };
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/v64-loader.mjs';
    script.dataset.v64Runtime = 'true';
    scope.__lumibootV64Resolve = (module): void => {
      delete scope.__lumibootV64Resolve;
      script.remove();
      resolve(module);
    };
    script.onerror = () => {
      delete scope.__lumibootV64Resolve;
      script.remove();
      reject(new Error('Unable to load /v64/libv86.mjs. Run pnpm assets:v64:prepare.'));
    };
    document.head.append(script);
  });
  return runtimePromise;
}

/** Loads the optional renderer once; failure leaves the 2D adapter usable. */
export function loadV64WebGpu(): Promise<void> {
  if (webGpuPromise !== null) return webGpuPromise;
  webGpuPromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('WebGPU renderer requires a browser document.'));
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-v64-webgpu]');
    if (existing) {
      if ((globalThis as { V86SVGARenderer?: unknown }).V86SVGARenderer) resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = '/v64/glbridge/libv86-webgpu.js';
    script.dataset.v64Webgpu = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Unable to load the optional v64 WebGPU renderer.'));
    document.head.append(script);
  });
  return webGpuPromise;
}

export async function createV64(options: V64Options): Promise<V64Runtime> {
  const module = await loadV64Runtime();
  return new module.V86(options);
}
