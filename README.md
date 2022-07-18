FeoTweet
========

A tool to sync tweets from Twitter to [FeoBlog].

To install with [Deno], run:

    deno install --allow-read --allow-net https://deno.land/x/feotweet/feotweet.ts
    # OR:
    deno install --allow-read --allow-net https://raw.githubusercontent.com/NfNitLoop/feotweet/main/feotweet.ts

See [feotweet.sample.toml] for sample configuration.

Then just periodically run `feotweet` to sync.

[FeoBlog]: https://github.com/nfnitloop/feoblog
[Deno]: https://deno.land/
[feotweet.sample.toml]: ./feotweet.sample.toml