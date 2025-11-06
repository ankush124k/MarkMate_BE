// utils/cryptoHelper.js
import crypto from "crypto";

const algorithm = "aes-256-cbc";
const secretKey = process.env.CREDENTIAL_SECRET;
const ivLength = 16;

// Encrypt function
export const encrypt = (text) => {
  const iv = crypto.randomBytes(ivLength);
  const cipher = crypto.createCipheriv(
    algorithm,
    crypto.createHash("sha256").update(secretKey).digest("base64").substr(0, 32),
    iv
  );
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
};

// Decrypt function
export const decrypt = (encryptedText) => {
  const [ivHex, encryptedHex] = encryptedText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");

  const decipher = crypto.createDecipheriv(
    algorithm,
    crypto.createHash("sha256").update(secretKey).digest("base64").substr(0, 32),
    iv
  );
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
};
