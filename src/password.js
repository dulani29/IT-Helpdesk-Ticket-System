const bcrypt = require("bcryptjs");
const ROUNDS = 12;
// A real bcrypt hash of a random value: compared against when the email is unknown so
// response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password-" + Math.random(), ROUNDS);

function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 72) return "Password must be 72 characters or fewer";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Password must contain at least one letter and one number";
  return null;
}
const hashPassword = pw => bcrypt.hash(pw, ROUNDS);
const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash || DUMMY_HASH);

module.exports = { passwordProblem, hashPassword, verifyPassword };
