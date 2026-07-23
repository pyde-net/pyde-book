# Runbook: private key leak

A validator's FALCON keypair (or the foundation treasury keypair) has been exposed. Anyone with the key can sign as that validator OR steal treasury funds.

## Symptom

- Operator reports leaked key (laptop stolen, repo committed by accident, S3 bucket public, etc.).
- OR: on-chain anomaly: unexpected `RotateValidatorKeys` from a validator the operator didn't issue, or treasury balance dropping without authorised send.
- OR: explorer / indexer detects unusual signing patterns from a validator (equivocation, double-signing).

## First check

```bash
# 1. Is the key still in your custody (locally)?
ls -la /etc/pyde/falcon.keypair
sudo md5sum /etc/pyde/falcon.keypair
# Compare md5 against your last known-good backup.

# 2. Is there evidence the key was used by someone else?
ADDR=$(pyde keys inspect /etc/pyde/falcon.keypair | grep address | awk '{print $2}')
curl -s -X POST https://rpc.testnet.pyde.network \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getValidator\",\"params\":[\"$ADDR\"]}" | jq .
# Look for pubkey changes you didn't authorise, or status === "jailed" you didn't expect.
```

## Triage decision tree

1. **Validator key or treasury key?**
   - Validator → continue. The race is to rotate before the attacker does.
   - Treasury / multisig → STOP this runbook and convene the multisig holders. Treasury recovery is governance-coordinated, not solo-operator.

2. **Did the attacker already rotate the validator's pubkey?**
   - `pyde_getValidator(addr).pubkey` ≠ what you generated → you've lost custody. Stake is irrecoverable; cut your losses + audit how the key leaked.
   - `pubkey` matches your keypair → race is still on, go to step 3.

3. **How was the key exposed?**
   - Git repo / S3 → rotate the leaked passphrase, generate a new key, audit IAM.
   - Laptop / device → revoke the password manager item, generate new key.
   - Server intrusion → assume the validator host is compromised; rotate AND rebuild the host.

4. **Was the key encrypted at rest with a strong passphrase?**
   - Yes → attacker still needs to crack Argon2id + ChaCha20-Poly1305 (effectively impossible with a strong password). Lower urgency.
   - No → urgent. The plaintext key is one `pyde_sendRawTransaction` away from being used.

## Recovery

```bash
# 1. Generate a new FALCON keypair OFF the validator host.
pyde keys generate --out ~/falcon-new.keypair --password-stdin <<< 'newstrongpassword'

# 2. Use the OLD (leaked) key to submit a RotateValidatorKeys tx pointing at the new pubkey.
#    This wins the race against the attacker if you move first.
pyde stake rotate \
  --rpc https://rpc.testnet.pyde.network \
  --falcon-keypair /etc/pyde/falcon.keypair --falcon-password-stdin \
  --new-pubkey-from ~/falcon-new.keypair \
  <<< 'oldpassphrase'

# 3. Wait for the rotation to confirm on-chain (~2 wave commits).
sleep 30
ADDR=$(pyde keys inspect /etc/pyde/falcon.keypair | grep address | awk '{print $2}')
NEW_PUBKEY=$(pyde keys inspect ~/falcon-new.keypair | grep pubkey | awk '{print $2}')
ON_CHAIN=$(curl -s -X POST https://rpc.testnet.pyde.network \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getValidator\",\"params\":[\"$ADDR\"]}" | jq -r .result.pubkey)
test "$ON_CHAIN" = "$NEW_PUBKEY" && echo ROTATED || echo FAILED

# 4. Stop the validator, replace the keypair file on disk, restart.
sudo systemctl stop pyde-validator
sudo mv /etc/pyde/falcon.keypair /etc/pyde/falcon.keypair.compromised
sudo cp ~/falcon-new.keypair /etc/pyde/falcon.keypair
sudo chown root:pyde /etc/pyde/falcon.keypair
sudo chmod 640 /etc/pyde/falcon.keypair
sudo systemd-creds encrypt --name=falcon-password - /etc/pyde/falcon-password.cred <<< 'newstrongpassword'
sudo systemctl start pyde-validator

# 5. Securely destroy the .compromised file after forensics complete.
sudo shred -u /etc/pyde/falcon.keypair.compromised
```

## Verify recovery

```bash
# Validator's on-chain pubkey is the new one:
ADDR=$(pyde keys inspect /etc/pyde/falcon.keypair | grep address | awk '{print $2}')
curl -s -X POST https://rpc.testnet.pyde.network \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"pyde_getValidator\",\"params\":[\"$ADDR\"]}" | jq .result.pubkey

# The validator is signing again with the new key:
sleep 60
curl -s http://127.0.0.1:9933/metrics | grep state_root_sigs_emitted_total
# Counter should be advancing.

# An unbond signed by the OLD key fails (proves the swap is binding):
pyde stake unbond \
  --rpc https://rpc.testnet.pyde.network \
  --falcon-keypair /etc/pyde/falcon.keypair.compromised --falcon-password-stdin \
  <<< 'oldpassphrase'
# Expected: receipt status == Reverted (auth_keys check fails).
```

## Post-mortem template

- **Time leak detected:**
- **Leak vector (git / S3 / laptop / server / phishing):**
- **Was the keypair encrypted at rest with strong passphrase?:**
- **Time to rotate after detection:**
- **Did the attacker rotate first? (stake recoverable?):**
- **Forensic chain-of-custody for the .compromised file:**
- **HSM evaluation status:**
- **Process change (CI secret scanning / pre-commit hook / etc.):**
