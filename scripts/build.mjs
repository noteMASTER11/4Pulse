import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function buildFirefox() {
  const target = path.join(root, "dist/firefox");

  removeDir(target);
  copyDir(path.join(root, "src/common"), target);

  copyFile(
    path.join(root, "src/firefox/manifest.json"),
    path.join(target, "manifest.json")
  );

  copyFile(
    path.join(root, "src/firefox/background.js"),
    path.join(target, "background.js")
  );

  console.log("Firefox build created:", target);
}

function buildChrome() {
  const target = path.join(root, "dist/chrome");

  removeDir(target);
  copyDir(path.join(root, "src/common"), target);

  copyFile(
    path.join(root, "src/chrome/manifest.json"),
    path.join(target, "manifest.json")
  );

  copyFile(
    path.join(root, "src/chrome/background.js"),
    path.join(target, "background.js")
  );

  copyFile(
    path.join(root, "src/chrome/offscreen.html"),
    path.join(target, "html/offscreen.html")
  );

  copyFile(
    path.join(root, "src/chrome/offscreen.js"),
    path.join(target, "html/offscreen.js")
  );

  copyDir(
    path.join(root, "src/chrome/rules"),
    path.join(target, "rules")
  );

  console.log("Chrome build created:", target);
}

const target = process.argv[2] ?? "all";

if (target === "firefox" || target === "all") {
  buildFirefox();
}

if (target === "chrome" || target === "all") {
  buildChrome();
}
