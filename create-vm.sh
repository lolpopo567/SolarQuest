#!/usr/bin/env bash
# Create the Solar Quest VM on Oracle Cloud Always Free, retrying until Oracle has capacity.
# Run it in Oracle Cloud Shell (console, top right ">_" icon), which is already logged in:
#   curl -fsSL https://raw.githubusercontent.com/lolpopo567/SolarQuest/main/create-vm.sh -o create-vm.sh && bash create-vm.sh
# It reuses or creates a network with ports 22, 80 and 443 open, then tries the free Ampere A1 shape (1 CPU, 6 GB)
# and the free AMD micro shape in every fault domain, once a minute, until one starts. Safe to run again.
# Keep the Cloud Shell tab open (it closes after about 20 minutes without a keypress: press Enter now and then).
set -uo pipefail
C="${OCI_TENANCY:?run this in Oracle Cloud Shell}"      # root compartment = tenancy
q() { "$@" 2>/dev/null; }
say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }

existing() {   # a 'solarquest' VM that is running or still starting (never launch a second one)
  oci compute instance list --compartment-id "$C" --display-name solarquest --all \
    --query "data[?\"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING'].id | [0]" --raw-output 2>/dev/null
}
ID=$(existing)
if [[ "$ID" == ocid* ]]; then
  say "A 'solarquest' VM already exists; waiting for it to run."
  oci compute instance get --instance-id "$ID" --wait-for-state RUNNING >/dev/null
else
  AD=$(oci iam availability-domain list --compartment-id "$C" --query 'data[0].name' --raw-output)
  say "Availability domain: $AD"

  # ---- network (reused if it exists)
  V=$(q oci network vcn list --compartment-id "$C" --display-name solarquest-vcn --query 'data[0].id' --raw-output)
  if [[ "$V" != ocid* ]]; then
    say "Creating network"
    V=$(oci network vcn create --compartment-id "$C" --cidr-blocks '["10.0.0.0/16"]' --display-name solarquest-vcn \
        --dns-label sqvcn --wait-for-state AVAILABLE --query data.id --raw-output)
    IG=$(oci network internet-gateway create --compartment-id "$C" --vcn-id "$V" --is-enabled true \
         --display-name solarquest-ig --wait-for-state AVAILABLE --query data.id --raw-output)
    RT=$(oci network vcn get --vcn-id "$V" --query 'data."default-route-table-id"' --raw-output)
    oci network route-table update --rt-id "$RT" --force --route-rules \
      "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IG\"}]" >/dev/null
  fi
  SL=$(oci network vcn get --vcn-id "$V" --query 'data."default-security-list-id"' --raw-output)
  oci network security-list update --security-list-id "$SL" --force --ingress-security-rules '[
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
    {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"protocol":"17","source":"0.0.0.0/0","udpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"protocol":"1","source":"0.0.0.0/0","icmpOptions":{"type":3,"code":4}}]' >/dev/null
  S=$(q oci network subnet list --compartment-id "$C" --vcn-id "$V" --query 'data[0].id' --raw-output)
  if [[ "$S" != ocid* ]]; then
    S=$(oci network subnet create --compartment-id "$C" --vcn-id "$V" --cidr-block 10.0.0.0/24 \
        --display-name solarquest-subnet --dns-label sqsub --wait-for-state AVAILABLE --query data.id --raw-output)
  fi
  say "Network ready, ports 22/80/443 open"

  # ---- SSH key for logging in from this Cloud Shell (RSA: Cloud Shell runs in FIPS mode, which refuses ed25519)
  [ -f ~/.ssh/id_rsa.pub ] || ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_rsa -q
  [ -f ~/.ssh/id_rsa.pub ] || { say "Could not create an SSH key in ~/.ssh"; exit 1; }

  image() {
    oci compute image list --compartment-id "$C" --operating-system "Canonical Ubuntu" --operating-system-version 24.04 \
      --shape "$1" --sort-by TIMECREATED --sort-order DESC --query 'data[0].id' --raw-output 2>>/tmp/sq-launch.log
  }
  : > /tmp/sq-launch.log
  IMG_A1=$(image VM.Standard.A1.Flex); IMG_E2=$(image VM.Standard.E2.1.Micro)
  say "Ubuntu images: A1 ${IMG_A1:0:30}...  E2 ${IMG_E2:0:30}..."
  if [[ "$IMG_A1" != ocid* && "$IMG_E2" != ocid* ]]; then say "No Ubuntu 24.04 image found:"; cat /tmp/sq-launch.log; exit 1; fi

  LAST=/tmp/sq-last.out
  try() {  # shape image fault-domain [shape-config]; prints the new instance id, Oracle's full reply goes to $LAST
    [[ "$2" == ocid* ]] || return 1
    local extra=(); [ -n "${4:-}" ] && extra=(--shape-config "$4")
    oci compute instance launch --compartment-id "$C" --availability-domain "$AD" --fault-domain "$3" \
      --shape "$1" "${extra[@]}" --image-id "$2" --subnet-id "$S" --assign-public-ip true \
      --display-name solarquest --ssh-authorized-keys-file ~/.ssh/id_rsa.pub > "$LAST" 2>&1
    local rc=$?
    { echo "== $(date +%T) $1 $3 exit $rc"; cat "$LAST"; } >> /tmp/sq-launch.log
    [ $rc -eq 0 ] && grep -o '"id": "ocid1.instance[^"]*"' "$LAST" | head -1 | cut -d'"' -f4
  }
  n=0
  while :; do
    n=$((n + 1))
    for fd in FAULT-DOMAIN-1 FAULT-DOMAIN-2 FAULT-DOMAIN-3; do
      ID=$(try VM.Standard.A1.Flex "$IMG_A1" "$fd" '{"ocpus":1,"memoryInGBs":6}'); [[ "$ID" == ocid* ]] && break 2
      ID=$(existing); [[ "$ID" == ocid* ]] && break 2          # launched despite an odd reply
      ID=$(try VM.Standard.E2.1.Micro "$IMG_E2" "$fd"); [[ "$ID" == ocid* ]] && break 2
      ID=$(existing); [[ "$ID" == ocid* ]] && break 2
    done
    if ! grep -qi "capacity" "$LAST"; then
      say "Oracle refused for a reason other than capacity. Its full reply:"; echo "-----"; cat "$LAST"; echo "-----"
      echo "(every attempt is logged in /tmp/sq-launch.log)"; exit 1
    fi
    say "Attempt $n: no free capacity yet. Retrying in 60 s... (Ctrl+C to stop)"
    sleep 60
  done
  say "Created! Waiting for it to start"
  oci compute instance get --instance-id "$ID" --wait-for-state RUNNING >/dev/null
fi

IP=$(oci compute instance list-vnics --instance-id "$ID" --query 'data[0]."public-ip"' --raw-output)
SHAPE=$(oci compute instance get --instance-id "$ID" --query 'data.shape' --raw-output)
echo
say "VM is running: $SHAPE, public IP $IP"
echo "Next:"
echo "  1. On duckdns.org set your subdomain's IP to $IP"
echo "  2. Log in from this Cloud Shell:   ssh ubuntu@$IP"
echo "  3. On the VM: curl -fsSL https://raw.githubusercontent.com/lolpopo567/SolarQuest/main/setup.sh -o setup.sh && bash setup.sh"
