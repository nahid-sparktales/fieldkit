import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

async function compress(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await compress(path);
    else if (/\.(html|js|css|svg)$/.test(entry.name)) {
      const input = await readFile(path);
      const outputs = await Promise.all([
        promisify(brotliCompress)(input, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
        }),
        promisify(gzip)(input, { level: 9 }),
      ]);
      for (const [index, extension] of ["br", "gz"].entries())
        if (outputs[index].length < input.length)
          await writeFile(`${path}.${extension}`, outputs[index]);
    }
  }
}
await compress("dist/web");
