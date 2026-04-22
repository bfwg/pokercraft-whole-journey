#!/usr/bin/env node
const forge = require("node-forge");

const IV = "tE5_yR0~uI2-oP4aL6kS8jD1fG3hH9z1";

function decode(headerA, hexData) {
  // Extract AES key: strip first 8 and last 8 chars from header 'a'
  const key = headerA.substring(8, headerA.length - 8);

  const decipher = forge.cipher.createDecipher("AES-CBC", key);
  decipher.start({ iv: IV });
  decipher.update(forge.util.createBuffer(forge.util.hexToBytes(hexData)));
  decipher.finish();

  const output = decipher.output.toString();
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

// CLI usage: node decode.js <header_a_value> <hex_data>
const [headerA, hexData] = process.argv.slice(2);

if (!headerA || !hexData) {
  console.error("Usage: node decode.js <header_a_value> <hex_data>");
  console.error("  header_a_value: the full value of response header 'a'");
  console.error("  hex_data:       the hex-encoded ciphertext from response body .data");
  process.exit(1);
}

const result = decode(headerA, hexData);
console.log(JSON.stringify(result, null, 2));
