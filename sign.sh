#!/bin/sh
# Sign DefconScript.js and write scriptSignature + scriptPublicKey into DefconConfig.json.
# The private key never lives in the repo: PRIVKEY defaults to the path below.
# Re-run after every script change, and bump "version" in the config first.
set -e

SCRIPT="DefconScript.js"
CONFIG="DefconConfig.json"
PRIVKEY="${PRIVKEY:-$HOME/.config/grayjay-source-defcon/private_key.pem}"

if [ ! -f "$PRIVKEY" ]; then
    echo "Error: $PRIVKEY not found (set PRIVKEY=/path/to/private_key.pem, or: openssl genrsa -out \"$PRIVKEY\" 2048)"
    exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

openssl dgst -sha512 -sign "$PRIVKEY" -out "$TMP/sig.bin" "$SCRIPT"
SIG=$(openssl base64 -A -in "$TMP/sig.bin")
PUBKEY=$(openssl rsa -pubout -outform PEM -in "$PRIVKEY" 2>/dev/null | grep -v -e '^-----' | tr -d '\n')

# Verify before touching the config
openssl rsa -pubout -outform DER -in "$PRIVKEY" -out "$TMP/pub.der" 2>/dev/null
openssl dgst -sha512 -verify "$TMP/pub.der" -signature "$TMP/sig.bin" "$SCRIPT"

jq --arg sig "$SIG" --arg pub "$PUBKEY" '.scriptSignature=$sig | .scriptPublicKey=$pub' "$CONFIG" > "$TMP/c.json"
mv "$TMP/c.json" "$CONFIG"
echo "Updated $CONFIG with a new signature."
