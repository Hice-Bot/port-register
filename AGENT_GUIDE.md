# Port Register — Agent Quick Reference

Port Register runs at **`http://localhost:4444`** and must be running before any agent starts.

---

## Required Workflow (Agents MUST Follow This)

1. **Check** if the desired port is free
2. **Register** the port with your agent name and reason
3. **Use** the port
4. **Release** the port when done (or let it expire via TTL)

---

## API Endpoints

### Check if a port is available
```
GET http://localhost:4444/api/ports/check/:port
```
Response:
```json
{
  "port": 3000,
  "available": true,
  "registeredBy": null,
  "osInUse": false,
  "recommendation": "Port 3000 appears to be free — safe to use"
}
```

### Register a port
```
POST http://localhost:4444/api/ports/register
Content-Type: application/json

{
  "port": 3000,
  "agent": "my-agent-name",
  "reason": "Next.js dev server for project X",
  "ttlMinutes": 30
}
```

### Get a suggested free port (in a range)
```
GET http://localhost:4444/api/suggest?min=3000&max=9999
```

### Release a port when done
```
DELETE http://localhost:4444/api/ports/:port
Content-Type: application/json

{ "agent": "my-agent-name" }
```

### Send a heartbeat (refresh TTL)
```
POST http://localhost:4444/api/ports/:port/heartbeat
Content-Type: application/json

{ "agent": "my-agent-name" }
```

### List all active registrations
```
GET http://localhost:4444/api/ports
```

---

## Bash One-liner Examples

### Check a port
```bash
curl -s http://localhost:4444/api/ports/check/3000 | python -m json.tool
```

### Register a port
```bash
curl -s -X POST http://localhost:4444/api/ports/register \
  -H "Content-Type: application/json" \
  -d '{"port":3000,"agent":"my-agent","reason":"Dev server"}'
```

### Get a free port suggestion
```bash
curl -s "http://localhost:4444/api/suggest?min=3000&max=9999"
```

### Release a port
```bash
curl -s -X DELETE http://localhost:4444/api/ports/3000 \
  -H "Content-Type: application/json" \
  -d '{"agent":"my-agent"}'
```

---

## Rules for Agents

- **Always check before binding.** Never assume a port is free.
- **Always register immediately after checking.** Don't wait — another agent could grab it.
- **Include your real name** in the `agent` field so others know who to contact.
- **Set a realistic TTL.** Default is 30 minutes. Long-running services should send heartbeats.
- **Release when done.** Don't rely solely on TTL expiry.

---

## Web Dashboard

Open **http://localhost:4444** in a browser to see the live registry.
