// deno-lint-ignore-file no-explicit-any // because TurndownService is untyped.

// TBH, the case for FeoTweet is:
// 1) I convert a tweet into HTML.
// 2) I convert that HTML into Markdown (Feoblog's native format)
// 
// Which seemed like a nice way to go because I could <blockquote>${quotedTweet.toHTML}</blockquote>
// and also rely on Turndown's to handle referenced links.
//
// But there are so many corner cases (see: Markdown.tests.ts)
// I'm starting to wonder if I should just write my own markdown renderer. :p

// Using a rather bleeding-edge DOMParser from DenoDOM.
// See: https://github.com/mixmark-io/turndown/issues/390
import { turndown, denoDOM } from "./deps.ts"

const domParser = new denoDOM.DOMParser()
const turndownService = new turndown.default({
    linkStyle: "referenced",
    // Would like to use "shortcut", but: https://github.com/mixmark-io/turndown/issues/393
    linkReferenceStyle: "full",
    // blankReplacement: (content: string, node: any, _options: any) => {
    //     console.log(`blank node name: ${node.nodeName}, type: ${node.nodeType}, isBlock: ${node.isBlock}`)
    //     console.log("blank content:", JSON.stringify(content))
        
    //     // default:
    //     return node.isBlock ? "\n\n" : ""
    // }
})

// In htmlToMarkdown, I collapse line returns in the HTML so that they don't
// leak into the Markdown. 
// See: https://github.com/mixmark-io/turndown/issues/394
// Unfortunately, if you collapse to spaces, now empty paragraphs get rendered in <blockquotes>
// Fix that:
function plugin(svc: any) {
    // See: https://github.com/mixmark-io/turndown/blob/ef41a54852afefb9383a5aa0668e1054bda3cc9b/src/commonmark-rules.js#L38
    svc.addRule("blockquote", {
        filter: 'blockquote',
        replacement: function (content: string) {
          content = content.replace(/^\s+|\s+$/g, '')
          content = content.replace(/^/gm, '> ')
          return '\n\n' + content + '\n\n'
        }
      })

}
turndownService.use(plugin)


export function htmlToMarkdown(html: string): string {

    // Work around: https://github.com/mixmark-io/turndown/issues/394
    // Note: Would break <pre> tags. 
    html = html.trim().replaceAll(/\s+/g, " ")

    const doc = domParser.parseFromString(html, "text/html")
    if (!doc) { 
        throw {
            error: `failed to parse HTML`, 
            html
        }
    }

    return turndownService.turndown(doc)
}