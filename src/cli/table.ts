/** Plain-text table with padded columns, shared by the CLI commands. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)));
  const format = (row: string[]) => row.map((entry, column) => entry.padEnd(widths[column])).join("  ").trimEnd();
  return [format(headers), format(widths.map((width) => "-".repeat(width))), ...rows.map(format)].join("\n");
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: CliIo = {
  out: (text) => console.log(text),
  err: (text) => process.stderr.write(`${text}\n`),
};
