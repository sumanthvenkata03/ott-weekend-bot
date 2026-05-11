import { execSync } from "node:child_process";

const prompt = "You are the social strategist for a Pan-Indian OTT + film industry Instagram page. In ONE sentence, tell me what makes a great Saturday Verdict post about a Telugu thriller landing on Aha.";

const output = execSync(`claude -p ${JSON.stringify(prompt)}`, {
  encoding: "utf-8",
  maxBuffer: 10 * 1024 * 1024,
  shell: "powershell.exe",
});

console.log("Claude says:\n", output);