# Edge Access Lab

A small edge security and request inspection playground.

## Components

- `origin/`: HTTP origin that returns incoming request headers
- `worker/`: Access JWT verification, identity HTML and private R2 country flags (see [setup](worker/README.md))

## Origin endpoint

The origin service returns the request method, path, client address, and all incoming HTTP headers as JSON.

```bash
curl -H "X-Demo: edge-access-lab" http://localhost:8080/headers
```
