// See: https://github.com/mixmark-io/turndown/issues/390

import { turndown, denoDOM } from "./deps.ts"

const domParser = new denoDOM.DOMParser()
const turndownService = new turndown.default({
    linkStyle: "referenced",
    // Would like to use "shortcut", but: https://github.com/mixmark-io/turndown/issues/393
    linkReferenceStyle: "full",
})

export function htmlToMarkdown(html: string): string {
    const doc = domParser.parseFromString(html, "text/html")
    if (!doc) { 
        throw {
            error: `failed to parse HTML`, 
            html
        }
    }

    return turndownService.turndown(doc)
}