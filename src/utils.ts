import * as fs from 'fs/promises';

export async function readFileWithEncoding(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return readTextFromBuffer(buffer);
}

export function readTextFromBuffer(buffer: Buffer): string {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        // UTF-16 LE
        return new TextDecoder('utf-16le').decode(buffer);
    } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        // UTF-16 BE
        return new TextDecoder('utf-16be').decode(buffer);
    } else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        // UTF-8 with BOM
        return new TextDecoder('utf-8').decode(buffer);
    } else {
        // Check if there are null bytes in the first 100 bytes (typical heuristic for UTF-16 without BOM)
        let hasNulls = false;
        const checkLen = Math.min(buffer.length, 100);
        for (let i = 0; i < checkLen; i++) {
            if (buffer[i] === 0) {
                hasNulls = true;
                break;
            }
        }
        if (hasNulls && buffer.length % 2 === 0) {
            return new TextDecoder('utf-16le').decode(buffer);
        }
        // Default UTF-8
        return new TextDecoder('utf-8').decode(buffer);
    }
}
