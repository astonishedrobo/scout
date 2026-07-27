import fileIcon from "material-icon-theme/icons/file.svg?url";
import folderIcon from "material-icon-theme/icons/folder.svg?url";
import folderOpenIcon from "material-icon-theme/icons/folder-open.svg?url";
import pythonIcon from "material-icon-theme/icons/python.svg?url";
import javascriptIcon from "material-icon-theme/icons/javascript.svg?url";
import typescriptIcon from "material-icon-theme/icons/typescript.svg?url";
import reactIcon from "material-icon-theme/icons/react.svg?url";
import reactTsIcon from "material-icon-theme/icons/react_ts.svg?url";
import htmlIcon from "material-icon-theme/icons/html.svg?url";
import cssIcon from "material-icon-theme/icons/css.svg?url";
import markdownIcon from "material-icon-theme/icons/markdown.svg?url";
import readmeIcon from "material-icon-theme/icons/readme.svg?url";
import jsonIcon from "material-icon-theme/icons/json.svg?url";
import yamlIcon from "material-icon-theme/icons/yaml.svg?url";
import tomlIcon from "material-icon-theme/icons/toml.svg?url";
import databaseIcon from "material-icon-theme/icons/database.svg?url";
import tableIcon from "material-icon-theme/icons/table.svg?url";
import pdfIcon from "material-icon-theme/icons/pdf.svg?url";
import imageIcon from "material-icon-theme/icons/image.svg?url";
import svgIcon from "material-icon-theme/icons/svg.svg?url";
import zipIcon from "material-icon-theme/icons/zip.svg?url";
import wordIcon from "material-icon-theme/icons/word.svg?url";
import powerpointIcon from "material-icon-theme/icons/powerpoint.svg?url";
import documentIcon from "material-icon-theme/icons/document.svg?url";
import consoleIcon from "material-icon-theme/icons/console.svg?url";
import dockerIcon from "material-icon-theme/icons/docker.svg?url";
import gitIcon from "material-icon-theme/icons/git.svg?url";
import nodeIcon from "material-icon-theme/icons/nodejs.svg?url";

const exactNames: Record<string, string> = {
  "package.json": nodeIcon,
  "package-lock.json": nodeIcon,
  "dockerfile": dockerIcon,
  ".gitignore": gitIcon,
  ".gitattributes": gitIcon,
  "readme.md": readmeIcon,
};

const extensions: Record<string, string> = {
  py: pythonIcon,
  js: javascriptIcon,
  mjs: javascriptIcon,
  cjs: javascriptIcon,
  jsx: reactIcon,
  ts: typescriptIcon,
  mts: typescriptIcon,
  cts: typescriptIcon,
  tsx: reactTsIcon,
  html: htmlIcon,
  htm: htmlIcon,
  css: cssIcon,
  scss: cssIcon,
  md: markdownIcon,
  markdown: markdownIcon,
  json: jsonIcon,
  yaml: yamlIcon,
  yml: yamlIcon,
  toml: tomlIcon,
  sql: databaseIcon,
  db: databaseIcon,
  sqlite: databaseIcon,
  csv: tableIcon,
  xls: tableIcon,
  xlsx: tableIcon,
  pdf: pdfIcon,
  png: imageIcon,
  jpg: imageIcon,
  jpeg: imageIcon,
  gif: imageIcon,
  webp: imageIcon,
  bmp: imageIcon,
  svg: svgIcon,
  zip: zipIcon,
  tar: zipIcon,
  gz: zipIcon,
  tgz: zipIcon,
  doc: wordIcon,
  docx: wordIcon,
  ppt: powerpointIcon,
  pptx: powerpointIcon,
  txt: documentIcon,
  log: documentIcon,
  sh: consoleIcon,
  bash: consoleIcon,
  zsh: consoleIcon,
};

export function fileTypeIconUrl(name: string) {
  const lower = name.toLowerCase();
  if (exactNames[lower]) return exactNames[lower];
  const parts = lower.split(".");
  // Compound extensions take precedence, matching VS Code icon-theme rules.
  for (let index = 1; index < parts.length; index++) {
    const compound = parts.slice(index).join(".");
    if (extensions[compound]) return extensions[compound];
  }
  return extensions[parts.at(-1) ?? ""] ?? fileIcon;
}

export function FileTypeIcon({
  name,
  directory = false,
  open = false,
  size = 16,
  className = "",
}: {
  name: string;
  directory?: boolean;
  open?: boolean;
  size?: number;
  className?: string;
}) {
  const src = directory ? (open ? folderOpenIcon : folderIcon) : fileTypeIconUrl(name);
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`shrink-0 object-contain saturate-[0.88] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
