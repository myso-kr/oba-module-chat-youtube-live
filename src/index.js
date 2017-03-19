import _ from 'lodash';
import Promise from 'bluebird';
import Logger from 'debug';
import EventEmitter from 'events'
import URL from 'url';
import Util from 'util';
import fetchNode from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import cheerio from 'cheerio';

const fetch = fetchCookie(fetchNode);

const HTTP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36';
const URL_BROADCAST_PLAY = "https://www.youtube.com/watch?v=%s"
const URL_BROADCAST_META = "https://www.youtube.com/live_chat?continuation=%s"
const URL_BROADCAST_SOCK = "https://www.youtube.com/live_chat/get_live_chat?pbj=1&continuation=%s"

export default class Module extends EventEmitter {
	constructor(oba, options, url) {
		super();
		this.name = "oba:chat:youtube-live";
		this.oba = oba || new EventEmitter();
		this.stdout = Logger(`${this.name}`);
		this.stderr = Logger(`${this.name}:error`);

		const uri = URL.parse(url, true, true);
        const segments = _.split(uri.pathname, '/');
        this.defaults = {
        	name: this.name,
        	source: url, 
        	caster: {
        		username: _.get(uri, 'query.v'),
        		identify: _.get(uri, 'query.v')
        	}
        };
        this.options = _.merge({}, this.defaults, options);
        this.socket = new Socket(this);
	}

	connect() { this.socket.connect(); }

	disconnect() { this.socket.disconnect(); }

    async meta() {
        const base = await fetch(Util.format(URL_BROADCAST_PLAY, this.defaults.caster.identify), {
            headers: { 'User-Agent': HTTP_USER_AGENT }
        }).then((resp)=>resp.text());
        const continuation = decodeURIComponent(_.get(/live_chat\?continuation=([0-9A-Z%-_=]+)/i.exec(base), 1));

        const meta = {continuation};
        const html = await fetch(Util.format(URL_BROADCAST_META, continuation), {
            headers: {
                'User-Agent': HTTP_USER_AGENT,
                'Referer': Util.format(URL_BROADCAST_PLAY, this.defaults.caster.identify)
            }
        }).then((resp)=>{

            return resp.text()
        });
        const $ = cheerio.load(html);
        {
            const script = $('script:contains("ytInitialData")').text().replace(/(^[\s]+)/igm, '');
            const offsetS = script.indexOf('{');
            const offsetE = script.indexOf('};', offsetS);
            _.set(meta, 'data', JSON.parse(script.substr(offsetS, offsetE - offsetS + 1)))
        }
        {
            const script = $('script:contains("ytcfg.set")').text().replace(/(^[\s]+)/igm, '');
            const offsetS = script.indexOf('({');
            const offsetE = script.indexOf('});', offsetS);
            _.set(meta, 'config', JSON.parse(script.substr(offsetS + 1, offsetE - offsetS)))
        }
        return meta;
    }

    async sock(continuation, config) {
        const resp = await fetch(Util.format(URL_BROADCAST_SOCK, continuation), {
            method: 'GET', compress: true,
            headers: {
                'User-Agent': HTTP_USER_AGENT,
                'Referer': Util.format(URL_BROADCAST_PLAY, this.defaults.caster.identify),
                'X-SPF-Previous': Util.format(URL_BROADCAST_PLAY, this.defaults.caster.identify),
                'X-SPF-Referer': Util.format(URL_BROADCAST_PLAY, this.defaults.caster.identify),
                'X-YouTube-Client-Name'      : _.get(config, 'INNERTUBE_CONTEXT_CLIENT_NAME'),
                'X-YouTube-Client-Version'   : _.get(config, 'INNERTUBE_CONTEXT_CLIENT_VERSION'),
                'X-Youtube-Identity-Token'   : _.get(config, 'ID_TOKEN'),
                'X-YouTube-Page-CL'          : _.get(config, 'PAGE_CL'),
                'X-YouTube-Page-Label'       : _.get(config, 'PAGE_BUILD_LABEL'),
                'X-YouTube-Variants-Checksum': _.get(config, 'VARIANTS_CHECKSUM')
            }
        }).then((resp)=>resp.json())
        return _.get(resp, 'response');
    }
}

class Socket extends EventEmitter {
	constructor(module) {
		super();
		this.module = module;
	}

    async handler(config, continuation) {
        if(this.break) return;
        const sock = await this.module.sock(continuation, config);
        const actions = _.get(sock, 'continuationContents.liveChatContinuation.actions', []);
        const timeout = 1000; //_.get(sock, 'continuationContents.liveChatRenderer.continuations[0].invalidationContinuationData.timeoutMs', 10000);
        const continuations = _.get(sock, 'continuationContents.liveChatContinuation.continuations');
        const continuationNext = _.get(_.last(continuations), 'invalidationContinuationData.continuation', continuation);
        
        _.each(actions, (action) => {
            if(!_.has(action, 'addChatItemAction')) return;
            let item = _.get(action, 'addChatItemAction.item.liveChatTextMessageRenderer');
            this.module.emit('message', {
                module: this.module.defaults,
                username: _.get(item, 'authorExternalChannelId'),
                nickname: _.get(item, 'authorName.runs[0].text'),
                message: _.get(item, 'message.runs[0].text'),
                timestamp: Date.now() // Math.floor(_.toNumber(_.get(item, 'timestampUsec')) / 1000)
            })
        })

        const timestamp = Date.now();
        while(Date.now() - timestamp < timeout) {
            if(this.break) return;
            await Promise.delay(100);
        }

        return this.handler(config, continuationNext);
    }

	connect() {
		if(this.native) return;
		this.break = false;
        this.native = true;
		Promise.resolve()
        .then(() => this.module.meta())
        .then((meta) => { this.module.emit('connect'); return meta; })
        .then((meta) => this.handler(meta.config, meta.continuation))
        .catch((e) => this.module.emit('error', e))
        .finally(() => {
            this.module.emit('close');
            this.native = false;
        })
	}
	disconnect() {
		if(!this.native) return;
		this.break = true;
	}
}