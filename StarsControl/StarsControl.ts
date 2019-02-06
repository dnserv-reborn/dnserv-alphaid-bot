import { ErrorMessages } from "@sb-types/Consts";
import { MessageReaction, User, Message, GuildMember } from "discord.js";
import * as getLogger from "loggy";
import { getMessageMember, getMessageMemberOrAuthor, EmbedType } from "@utils/utils";
import { INullableHashMap, IHashMap } from "@sb-types/Types";
import { timeDiff } from "@utils/time";
import * as text from "@utils/text";
import { UserIdentify, generateLocalizedEmbed, ExtensionAssignUnhandleFunction, extendAndAssign, localizeForUser } from "@utils/ez-i18n";
import { IModule } from "@sb-types/ModuleLoader/Interfaces.new";
import { ModulePrivateInterface } from "@sb-types/ModuleLoader/PrivateInterface";
import { instant, saveInstant } from "@utils/config";

export interface IStarControlSettings {
	/**
	 * Server this module working for
	 */
	guildId: string;
	/**
	 * Which messages getting disqualified from starring
	 *
	 * All messages by bots by default
	 */
	badStars?: IMessageDisqualification[];
	/**
	 * Disallowance of self starring
	 *
	 * `true` by default
	 */
	selfStarring?: boolean;
	/**
	 * Emoji used to star messages
	 * 
	 * "⭐" by default
	 */
	starEmoji?: string;
	/**
	 * Who cannot star the messages
	 * 
	 * "$bots" by default
	 */
	blockedStarrers?: string[];
}

interface IMessageDisqualification {
	/**
	 * Which authors this condition works on
	 *
	 * Can be "$bots", "$hooks" / "$hook:HOOK_ID"
	 */
	authors?: string[];
	/**
	 * Which channels this condition works on
	 * 
	 * This disables all stars per channel
	 */
	channels?: string[];
	/**
	 * Conditions against the message content
	 */
	content?: ContentDisqualifyCondition;
	/**
	 * In minutes, how old message can be to be starred
	 */
	aged?: number;
	/**
	 * Reason for this disqualification
	 */
	reason?: string;
}

type ContentDisqualifyCondition = ["equal" | "starts" | "ends" | "includes", string];

const DAY_IN_MINUTES = 1440;
const STAR_REACTION = "⭐";

const REGEX_CACHE: INullableHashMap<RegExp> = Object.create(null);

export class StarsControl implements IModule<StarsControl> {
	private static readonly _log = getLogger("dnSERV: StarsControl");

	private _handler?: ReactionHandler;
	private _i18nUnhandle?: ExtensionAssignUnhandleFunction;

	private _settings: IStarControlSettings;
	private _compiledDisqualificationProcess?: AnyOfResult<IAddedReaction, string | boolean>;

	public async init(i: ModulePrivateInterface<StarsControl>) {
		if (i.baseCheck(this) && !i.isPendingInitialization()) {
			throw new Error(ErrorMessages.NOT_PENDING_INITIALIZATION);
		}

		const fix = i.getDependency("reactions-fixer");

		if (!fix) {
			StarsControl._log(
				"warn",
				"`reaction-fixer` module is recommended to install"
			);
		}

		await this._initConfig(i);

		await this._initLocalization(i);

		const settings = this._settings;

		const disqualificationSteps: ReactionChecks = (
			Object.create(null)
		);

		if (settings.blockedStarrers) {
			disqualificationSteps["USER-BLOCK"] = (
				(toCheck) => this._handleBlockedStarrers(toCheck)
			);
		}

		if (settings.badStars) {
			disqualificationSteps["FILTER"] = (
				(toCheck) => this._handleDisqualify(toCheck)
			);
		}

		if (settings.selfStarring) {
			disqualificationSteps["SELF-STAR"] = (
				(toCheck) => this._handleSelfStar(toCheck)
			);
		}

		this._compiledDisqualificationProcess = calledAnyOf(
			disqualificationSteps
		);

		const handler = (reaction: MessageReaction, user: User) =>
			this._handleReactionAdding(reaction, user);

		$discordBot.on("messageReactionAdd", handler);

		this._handler = handler;

		return;
	}

	private async _initConfig(i: ModulePrivateInterface<StarsControl>) {
		const cfg = (await instant<IStarControlSettings>(i))[1];

		if (!cfg) {
			const path = await saveInstant<IStarControlSettings>(i, {
				guildId: "SERVER ID"
			});

			StarsControl._log("err", `No configuration found. An example config created at "${path}", please replace needed values before starting the bot again`);

			throw new Error("No configuration file found. An example config created");
		}

		if (!cfg.guildId) throw new Error("Guild ID must be provided in config");

		this._settings = {
			starEmoji: STAR_REACTION,
			selfStarring: true,
			blockedStarrers: [
				// Bots should not star messages
				"$bots"
			],
			badStars: [
				// Messages that sent by bots
				{ authors: ["$bots", "$hooks"] },
				// Messages that are older than one day
				{ aged: DAY_IN_MINUTES }
			],
			// Dirty hacks, but it works
			...(<IStarControlSettings> cfg)
		};
	}

	private async _initLocalization(i: ModulePrivateInterface<StarsControl>) {
		this._i18nUnhandle = await extendAndAssign([__dirname, "i18n"], i);
	}

	private async _handleReactionAdding(reaction: MessageReaction, user: User) {
		const { emoji, message } = reaction;
		const { starEmoji, guildId } = this._settings;
		const { guild } = message;

		if (!guild || guild.id !== guildId) {
			return false;
		}

		if (emoji.name !== starEmoji) {
			return false;
		}

		const disqualProcess = this._compiledDisqualificationProcess;

		if (!disqualProcess) {
			StarsControl._log(
				"warn",
				"Star Disqualification Process is not compiled!"
			);

			return false;
		}

		const disqualReasons = await (
			disqualProcess({
				reaction,
				user
			})
		);

		if (disqualReasons) {
			StarsControl._log(
				"info",
				`Disallow reaction by ${user.tag} on message ${reaction.message.id} because: ${disqualReasons}"`
			);

			await StarsControl._removeReaction(reaction, user);

			try {
				const member = guild.members.get(user.id);

				const autoReason = disqualReasons[0];
				const reason = disqualReasons[1];

				if (typeof reason === "string") {
					await StarsControl._sendReasonedWarning(
						member || user,
						autoReason,
						reason
					);
				} else {
					await StarsControl._sendWarning(
						member || user,
						autoReason
					);
				}
			} catch (err) {
				StarsControl._log("warn", `Cannot send warning (${disqualReasons}) to ${user.tag}`);
			}

			return true;
		}

		return false;
	}

	// #region Self-starring

	private async _handleSelfStar(toCheck: IAddedReaction) {
		const { reaction, user } = toCheck;

		const { selfStarring } = this._settings;

		if (!selfStarring) { return false; }

		const { message } = reaction;

		const poster = await getMessageMember(message);

		if (!poster || (poster.user !== user)) {
			return false;
		}

		return true;
	}

	// #endregion

	// #region Disqualification

	private async _handleDisqualify(toCheck: IAddedReaction) {
		const disquals = this._settings.badStars;

		if (!disquals) return false;

		const { reaction } = toCheck;

		for (let i = 0, l = disquals.length; i < l; i++) {
			const disqual = disquals[i];

			const disqualify = await (
				StarsControl._isDisqualified(
					reaction,
					disqual
				)
			);

			if (disqualify) return disqual.reason || true;
		}

		return false;
	}

	private static async _isDisqualified(reaction: MessageReaction, disqual: IMessageDisqualification) {
		const { message: msg } = reaction;

		const { aged } = disqual;

		if (aged != null) {
			const minsSince = StarsControl._minutesSinceSent(msg);

			if (minsSince < aged) return false;
		}

		const { channels } = disqual;

		if (channels) {
			const channelId = msg.channel.id;

			if (!channels.includes(channelId)) {
				return false;
			}
		}

		const { authors } = disqual;

		if (authors) {
			const isAuthored = await (
				StarsControl._authoredBy(
					msg, authors
				)
			);

			if (!isAuthored) return false;
		}

		const { content } = disqual;

		if (content) {
			const isMatches = StarsControl._contentMatch(
				msg.content,
				content
			);
			
			if (!isMatches) return false;
		}

		return true;
	}

	private static async _contentMatch(content: string, cond: ContentDisqualifyCondition) {
		const [ pos, match ] = cond;

		if (
			(pos === "equal" && content === match) ||
			(pos === "includes" && content.includes(match)) ||
			(pos === "starts" && text.startsWith(content, match)) ||
			(pos === "ends" && text.endsWith(content, match))
		) {
			return true;
		}

		return false;
	}

	private static async _authoredBy(msg: Message, authors: string[]) {
		// ["$bots", "$hooks", "450587652383834112"]
		// message.author.bot (true) -> true
		// message.author.id ("450587652383834112") -> true
		// message.webhookID (123456) -> true
		// message.author.id ("172002275412279296") -> false

		let sender = await getMessageMemberOrAuthor(msg);

		if (sender instanceof GuildMember) {
			sender = sender.user;
		}

		for (let i = 0, l = authors.length; i < l; i++) {
			const author = authors[i];

			if (author === "$bots") {
				if (sender && sender.bot) { 
					return true;
				}

				continue;
			} else if (author === "$hooks") {
				if (msg.webhookID) {
					return true;
				}

				continue;
			} else if (author.startsWith("$hook:")) {
				const hookId = author.slice("$hook:".length);

				if (msg.webhookID === hookId) { 
					return true;
				}

				continue;
			}

			if (sender && sender.id === author) {
				return true;
			}
		}

		return false;
	}

	private static _minutesSinceSent(msg: Message) {
		const passed = timeDiff(Date.now(), msg.createdAt, "s");

		return passed / 60;
	}

	// #endregion

	// #region Blocked Starrers

	private async _handleBlockedStarrers(toCheck: IAddedReaction) {
		const { blockedStarrers } = this._settings;

		if (!blockedStarrers) {
			return false;
		}

		const { user } = toCheck;

		if (StarsControl._starredBy(user, blockedStarrers)) {
			return true;
		}

		return false;
	}


	private static _starredBy(user: User, starrers: string[]) {
		for (let i = 0, l = starrers.length; i < l; i++) {
			const starrer = starrers[i];

			if (starrer === "$bots") {
				if (user.bot) {
					return true;
				}

				continue;
			} else if (text.startsWith(starrer, "$username:")) {
				const username = starrer.slice("$username".length);

				if (user.username === username) { return true; }

				continue;
			} else if (text.startsWith(starrer, "$username_reg:")) {
				const reg = starrer.slice("$username_reg:".length);

				if (regExp(reg).test(user.username)) {
					return true;
				}

				continue;
			}

			if (user.id === starrer) {
				return true;
			}
		}

		return false;
	}

	// #endregion

	// #region Censure

	private static async _removeReaction(reaction: MessageReaction, user: User) {
		const { emoji, message, users } = reaction;

		StarsControl._log(
			"info",
			`Remove reaction of ${emoji.toString()} by ${user.tag} on message ${message.id}`
		);

		return users.remove(user);
	}

	private static getAutoReasonStr(autoReason: string) {
		return `DNSERV_STAR_BLOCKED@${autoReason}`;
	}

	private static async _sendReasonedWarning(user: UserIdentify, autoReason: string, reason: string) {
		let str = await localizeForUser(user, StarsControl.getAutoReasonStr(autoReason));
		str += "\n\n";

		str += await localizeForUser(user, "DNSERV_STAR_BLOCKED_REASON", { reason });

		return user.send({
			embed: await generateLocalizedEmbed(
				EmbedType.Warning,
				user, {
					custom: true,
					string: str
				}
			)
		});
	}

	private static async _sendWarning(user: UserIdentify, autoReason: string) {
		return user.send({
			embed: await generateLocalizedEmbed(
				EmbedType.Warning,
				user,
				StarsControl.getAutoReasonStr(autoReason)
			)
		});
	}

	// #endregion

	public async unload(i: ModulePrivateInterface<StarsControl>) {
		if (i.baseCheck(this) && !i.isPendingUnload()) {
			throw new Error(
				ErrorMessages.NOT_PENDING_UNLOAD
			);
		}

		const {
			_handler: handler,
			_i18nUnhandle: i18nUnhandle
		} = this;

		if (handler) {
			$discordBot.removeListener(
				"messageReactionAdd",
				handler
			);
		}

		if (i18nUnhandle) {
			i18nUnhandle();
		}

		return true;
	}
}

type ReactionHandler = (reaction: MessageReaction, user: User) => Promise<any>;

interface IAddedReaction {
	reaction: MessageReaction;
	user: User;
}

function calledAnyOf<T, R>(functions: CalledMap<T, R>, how?: (res: R) => boolean) : AnyOfResult<T, R> {
	return async (...args) => {
		for (const name in functions) {
			const func = functions[name];

			const res = await func(...args);

			if (!how && res) return [name, res];
			else if (how && how(res)) return [name, res];
		}
	};
}

/**
 * Map with check function
 */
type CalledMap<T, R> = IHashMap<AnyOfChecker<T, R>>;
/**
 * The function that checks
 */
type AnyOfChecker<T, R> = (toCheck: T) => Promise<R>;
/**
 * The result of AnyOf function
 */
type AnyOfResult<T, R> = (toCheck: T) => Promise<[string, R | undefined] | undefined>;

function regExp(str: string) {
	const cached = REGEX_CACHE[str];
	
	if (cached) { return cached; }

	return REGEX_CACHE[str] = new RegExp(str);
}

type ReactionChecks = IHashMap<AnyOfChecker<IAddedReaction, boolean | string>>;

export default StarsControl;
