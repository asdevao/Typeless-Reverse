import { readFileSync } from "node:fs";
import { msg } from "../../i18n/index.mjs";
import { parse, UsageError } from "../common.mjs";
import {
  addEntry,
  loadDictionary,
  parseDictionaryCsv,
  removeEntry,
  saveDictionary,
} from "../../storage/dictionary.mjs";

// speakmore dict：个人词典（专有名词热词）管理。词典是本机 JSON（dictionary.json），直接读写文件——
// 后台应用每次听写现读，改了当场生效，不用重启。CSV 导入对齐原版的专有名词纠正。

export async function dict(args, io) {
  const [action = "list", ...rest] = args;
  const file = io.paths.dictionaryFile;
  const entries = loadDictionary(file);

  switch (action) {
    case "list": {
      if (entries.length === 0) {
        io.out(io.t("cli.dict.empty"));
        return 0;
      }
      for (const { wrong, correct } of entries) io.out(`${wrong} → ${correct}`);
      io.out(io.t("cli.dict.count", { count: entries.length }));
      return 0;
    }

    case "add": {
      const [wrong, correct] = rest;
      if (wrong === undefined || correct === undefined) throw new UsageError(msg("cli.dict.usageAdd"));
      saveDictionary(file, addEntry(entries, wrong, correct));
      io.out(io.t("cli.dict.added", { wrong, correct }));
      return 0;
    }

    case "remove": {
      const [wrong] = rest;
      if (wrong === undefined) throw new UsageError(msg("cli.dict.usageRemove"));
      const remaining = removeEntry(entries, wrong);
      const removed = remaining.length !== entries.length;
      saveDictionary(file, remaining);
      io.out(io.t(removed ? "cli.dict.removed" : "cli.dict.notFound", { wrong }));
      return 0;
    }

    case "import-csv": {
      const [csvFile] = rest;
      if (csvFile === undefined) throw new UsageError(msg("cli.dict.usageImport"));
      const imported = parseDictionaryCsv(readFileSync(csvFile, "utf8"));
      let merged = entries;
      for (const entry of imported) merged = addEntry(merged, entry.wrong, entry.correct);
      saveDictionary(file, merged);
      io.out(io.t("cli.dict.imported", { count: imported.length, total: merged.length }));
      return 0;
    }

    default:
      throw new UsageError(msg("cli.dict.unknownAction", { action }));
  }
}
