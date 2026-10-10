# Operations

Environments, backups, and runbooks (STANDARD 7; STANDARD 8.3). One file, updated when anything here changes. Names of keys only, never values.

## Environments

| Environment | URL | Hosting | Database | Keys used (names only) | Deployed by |
|---|---|---|---|---|---|
| local | http://localhost:3000 | developer machine | local Supabase | <names> | n/a |
| staging | <url> | <host> | <project> | <names> | <Owner> |
| production | <url> | <host> | <project> | <names> | Owner only |

## Backups and restore

<Backup schedule, recovery window, and the date and evidence path of the last restore actually performed into a scratch environment (STANDARD 7.2).>

## Error monitoring

<Tool, what it captures, and confirmation that it captures no private data by default (STANDARD 7.3).>

## Go-live checklist

- [ ] Staging exists
- [ ] Restore tested
- [ ] Secrets scanned
- [ ] Security review passed
- [ ] Monitoring on

## Runbooks

<One section per routine or emergency procedure: when to use it, the exact steps, and who may run it.>
