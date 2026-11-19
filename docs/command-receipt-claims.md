# Note and profile command claims

Apply Drizzle migration `0006_command_receipt_claims` before deploying the Worker that uses claims. It allows a transaction to insert a receipt before its result is known. Existing completed receipts and their fingerprints stay valid; the previous Worker can run on the migrated schema.

Authorization holds compatible share locks to protect the membership and workspace against revocation or deletion during a write. The receipt primary key `(workspace_id, command_id)` arbitrates retries. After a conflicting insert, a separate statement at READ COMMITTED reads the committed result and checks the actor and fingerprint. A failed transaction rolls back the claim with the write, history and outbox entry.

Revision zero means insert-if-absent; subsequent saves and soft deletes use an update conditional on workspace, record ID, expected revision and a live row. Only a rejected write reads the current revision separately. Independent commands against different records no longer wait on an exclusive workspace lock.

This removes two sequential statements from an ordinary successful rename (eight to six, excluding transaction control). It does not establish production request latency; measure lock waits and end-to-end acknowledgement time after rollout.
