#!/bin/bash

# Natsable - Certificate Generation Script
# Creates a self-signed CA, server certificate, and client certificates

set -e

CERTS_DIR="$(dirname "$0")/../certs"
mkdir -p "$CERTS_DIR"
cd "$CERTS_DIR"

# Configuration
CA_DAYS=3650  # 10 years for CA
CERT_DAYS=365  # 1 year for certificates
COUNTRY="US"
STATE="California"
LOCALITY="San Francisco"
ORG="Natsable"
ORG_UNIT="Development"

echo "=== Natsable Certificate Generator ==="
echo ""

# ============================================
# 1. Generate Root CA
# ============================================
echo "[1/4] Generating Root CA..."

if [ ! -f ca.key ]; then
    # Generate CA private key
    openssl ecparam -name prime256v1 -genkey -noout -out ca.key

    # Generate CA certificate
    openssl req -new -x509 -sha256 -days $CA_DAYS \
        -key ca.key \
        -out ca.crt \
        -subj "/C=$COUNTRY/ST=$STATE/L=$LOCALITY/O=$ORG/OU=$ORG_UNIT/CN=Natsable Root CA"

    echo "  - Created ca.key (CA private key)"
    echo "  - Created ca.crt (CA certificate)"
else
    echo "  - CA already exists, skipping..."
fi

# ============================================
# 2. Generate Server Certificate
# ============================================
echo ""
echo "[2/4] Generating Server Certificate..."

if [ ! -f server.key ]; then
    # Generate server private key
    openssl ecparam -name prime256v1 -genkey -noout -out server.key

    # Create server CSR config
    cat > server.cnf << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
C = $COUNTRY
ST = $STATE
L = $LOCALITY
O = $ORG
OU = $ORG_UNIT
CN = nats-server

[req_ext]
subjectAltName = @alt_names
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
DNS.2 = nats
DNS.3 = nats-server
DNS.4 = *.natsable.local
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

    # Generate server CSR
    openssl req -new -sha256 \
        -key server.key \
        -out server.csr \
        -config server.cnf

    # Create server certificate extensions file
    cat > server_ext.cnf << EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = nats
DNS.3 = nats-server
DNS.4 = *.natsable.local
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

    # Sign server certificate with CA
    openssl x509 -req -sha256 -days $CERT_DAYS \
        -in server.csr \
        -CA ca.crt \
        -CAkey ca.key \
        -CAcreateserial \
        -out server.crt \
        -extfile server_ext.cnf

    # Clean up CSR and temp files
    rm -f server.csr server.cnf server_ext.cnf

    echo "  - Created server.key (server private key)"
    echo "  - Created server.crt (server certificate)"
else
    echo "  - Server certificate already exists, skipping..."
fi

# ============================================
# 3. Generate Admin Client Certificate
# ============================================
echo ""
echo "[3/4] Generating Admin Client Certificate..."

if [ ! -f admin-client.key ]; then
    # Generate client private key
    openssl ecparam -name prime256v1 -genkey -noout -out admin-client.key

    # Create client CSR config
    cat > client.cnf << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn

[dn]
C = $COUNTRY
ST = $STATE
L = $LOCALITY
O = $ORG
OU = $ORG_UNIT
CN = admin@natsable.local
emailAddress = admin@natsable.local
EOF

    # Generate client CSR
    openssl req -new -sha256 \
        -key admin-client.key \
        -out admin-client.csr \
        -config client.cnf

    # Create client certificate extensions file
    cat > client_ext.cnf << EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = email:admin@natsable.local
EOF

    # Sign client certificate with CA
    openssl x509 -req -sha256 -days $CERT_DAYS \
        -in admin-client.csr \
        -CA ca.crt \
        -CAkey ca.key \
        -CAcreateserial \
        -out admin-client.crt \
        -extfile client_ext.cnf

    # Clean up
    rm -f admin-client.csr client.cnf client_ext.cnf

    echo "  - Created admin-client.key (admin client private key)"
    echo "  - Created admin-client.crt (admin client certificate)"
else
    echo "  - Admin client certificate already exists, skipping..."
fi

# ============================================
# 4. Generate a sample user client certificate
# ============================================
echo ""
echo "[4/4] Generating Sample User Client Certificate..."

if [ ! -f user1-client.key ]; then
    # Generate client private key
    openssl ecparam -name prime256v1 -genkey -noout -out user1-client.key

    # Create client CSR config
    cat > client.cnf << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn

[dn]
C = $COUNTRY
ST = $STATE
L = $LOCALITY
O = $ORG
OU = Users
CN = user1@natsable.local
emailAddress = user1@natsable.local
EOF

    # Generate client CSR
    openssl req -new -sha256 \
        -key user1-client.key \
        -out user1-client.csr \
        -config client.cnf

    # Create client certificate extensions file
    cat > client_ext.cnf << EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = email:user1@natsable.local
EOF

    # Sign client certificate with CA
    openssl x509 -req -sha256 -days $CERT_DAYS \
        -in user1-client.csr \
        -CA ca.crt \
        -CAkey ca.key \
        -CAcreateserial \
        -out user1-client.crt \
        -extfile client_ext.cnf

    # Clean up
    rm -f user1-client.csr client.cnf client_ext.cnf

    echo "  - Created user1-client.key (user1 client private key)"
    echo "  - Created user1-client.crt (user1 client certificate)"
else
    echo "  - User1 client certificate already exists, skipping..."
fi

# ============================================
# Summary
# ============================================
echo ""
echo "=== Certificate Generation Complete ==="
echo ""
echo "Files created in $CERTS_DIR:"
ls -la "$CERTS_DIR"/*.{crt,key} 2>/dev/null || true
echo ""
echo "CA Certificate fingerprint:"
openssl x509 -in ca.crt -noout -fingerprint -sha256
echo ""
echo "Server Certificate details:"
openssl x509 -in server.crt -noout -subject -issuer
echo ""
echo "To verify the server certificate:"
echo "  openssl verify -CAfile ca.crt server.crt"
echo ""
echo "To verify the client certificates:"
echo "  openssl verify -CAfile ca.crt admin-client.crt"
echo "  openssl verify -CAfile ca.crt user1-client.crt"
