# Compatibility and controller discovery

## Support boundary

| Component | Support evidence |
| --- | --- |
| Node.js | Package requires Node 20 or newer |
| Operating system | Offline validation on Linux; native macOS/Windows behavior needs platform validation |
| AWX | 24.6.1 compatibility anchor, verified with offline tagged response fixtures |
| AAP gateway | Best-effort API-path support; gateway authentication and live compatibility are unverified |

The [current AWX API reference](https://docs.ansible.com/projects/awx/en/latest/rest_api/api_ref.html) describes upstream resources.
The [24.6.1 reference](https://docs.ansible.com/projects/awx/en/24.6.1/rest_api/) and [accepted design](design.md) anchor this CLI's compatibility contract.
Offline fixtures do not establish live controller or gateway compatibility.

## Discovery and cache

Commands default to `/api/v2/` before discovery.
The first dashboard invocation probes `/api/` unless an API-path override is set, then reads the resolved `ping/`.
Discovery uses unauthenticated reads and caches the API path and release under the state directory's `controllers/` directory.
Explicit commands reuse that cache.
Set `AWX_AXI_API_BASE_PATH=/api/controller/v2/` for a gateway path when needed; this does not add gateway token issuance.
An explicit API path takes precedence over the cached path.

The cache has no automatic expiry.
After an upgrade, remove the corresponding controller cache file to rediscover metadata on the next dashboard invocation.
Cache filenames are hashes of the origin and API-path override; each file records `apiBasePath` and `release`.
See [configuration](configuration.md#paths) for the state directory on each platform.
