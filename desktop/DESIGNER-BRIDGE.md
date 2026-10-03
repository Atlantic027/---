# Designer bridge contract

The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and
`sandbox: true`. The only global exposed by preload is
`window.classroomDesktop`:

```ts
type WifiNetwork = {
  interfaceId: string; interfaceName: string; ssid: string; signal: number;
  security: 'open' | 'wpa2-personal' | 'unsupported';
  connected: boolean; connectable: boolean;
};
type DiscoveryAddress = { name: string; ip: string; netmask: string };
type ServiceStatus = {
  running: boolean; origin: string; port: number; teacherUrl: string;
  candidate: true; modelIncluded: false;
};
interface ClassroomDesktop {
  listNetworks(): Promise<{ ok: boolean; networks: WifiNetwork[]; error?: string }>;
  connectNetwork(input: {
    interfaceId: string; ssid: string; password: string;
    security: 'open' | 'wpa2-personal';
  }): Promise<{ ok: boolean; connected?: boolean; ssid?: string; error?: string }>;
  getLocalAddresses(): Promise<DiscoveryAddress[]>;
  getServiceStatus(): Promise<ServiceStatus>;
}
```

The bridge has no file, arbitrary process, raw IPC, token, or password API.
The network settings entry point is `/desktop-network.html`; its page is
intentionally minimal so designer can replace its layout while keeping the
contract.
