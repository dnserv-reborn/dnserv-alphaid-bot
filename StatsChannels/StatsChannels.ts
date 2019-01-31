import * as getLogger from "loggy";
import * as config from "@utils/config";
import { isEmpty } from "@utils/extensions";
import { IModule } from "@sb-types/ModuleLoader/Interfaces.new";
import { DateTime } from "luxon";
import { ErrorMessages } from "@sb-types/Consts";
import { Guild, VoiceChannel } from "discord.js";
import { ModulePrivateInterface } from "@sb-types/ModuleLoader/PrivateInterface";
import { toGuildLocaleString, extendAndAssign, ExtensionAssignUnhandleFunction, localizeForGuild } from "@utils/ez-i18n";

export interface IStatsChannelsSettings {
	guildId: string;
	channels: StatsChannelsSetting;
}

type StatsChannelsSetting = StatsChannelsProto<string>;

type StatsChannelsProto<T> = {
	members?: T;
	time?: T;
};

type ResolvingData = {
	guild: Guild;
	resolvedChannels: ResolvedChannels
};

const CHANNEL_TYPES: Array<keyof StatsChannelsProto<any>> = ["members", "time"];

const ONE_MINUTE = 60000; // ms

export class StatsChannels implements IModule<StatsChannels> {
	private static readonly _log = getLogger("dnSERV: StatsChannels");

	private _i18nUnhandle?: ExtensionAssignUnhandleFunction;
	private _managedGuild: Guild;
	private _resolvedChannels: StatsChannelsProto<VoiceChannel>;
	private _scheduledIntervalInit?: NodeJS.Timer;
	private _updateInterval?: NodeJS.Timer;

	public async init(i: ModulePrivateInterface<this>) {
		if (i.baseCheck(this) && !i.isPendingInitialization()) {
			throw new Error(ErrorMessages.NOT_PENDING_INITIALIZATION);
		}

		const settings = await this._initConfig(i);

		const resolvingData = StatsChannels._resolveData(settings);

		if (!resolvingData) return;

		this._managedGuild = resolvingData.guild;
		this._resolvedChannels = resolvingData.resolvedChannels;

		await this._initLocalization(i);

		this._scheduledIntervalInit = setTimeout(
			() => this._initInterval(),
			StatsChannels._msUntilNextMinute()
		);
	}

	private async _initConfig(i: ModulePrivateInterface<StatsChannels>) {
		const settings = (await config.instant<IStatsChannelsSettings>(i))[1];

		if (!settings) {
			const path = await config.saveInstant<IStatsChannelsSettings>(i, {
				guildId: "SERVER ID",
				channels: {
					members: "LOCKED VOICE CHAT ID"
				}
			});

			StatsChannels._log("err", `No configuration found. An example config created at "${path}", please replace needed values before starting the bot again`);

			throw new Error("No configuration file found. An example config created");
		}

		if (!settings.guildId) throw new Error("Guild ID must be provided in the config");

		if (!settings.channels) throw new Error("Channel configuration must be provided in the config");

		return <IStatsChannelsSettings> settings;
	}

	private static _resolveData(settings: IStatsChannelsSettings) : ResolvingData | undefined {
		if (!isEmpty(settings.channels)) throw new Error("Channel configuration must not be empty");

		const guild = $discordBot.guilds.get(settings.guildId);

		if (!guild) {
			if ($botConfig.sharded) return;

			throw new Error(`Cannot find guild "${settings.guildId}"`);
		}

		const loggedIDs: string[] = [];

		const resolvingData: ResolvingData = {
			resolvedChannels: Object.create(null),
			guild
		};

		for (let i = 0, l = CHANNEL_TYPES.length; i < l; i++) {
			const channelRole = CHANNEL_TYPES[i];

			const channelId = settings.channels[channelRole];

			if (!channelId) continue;

			if (loggedIDs.includes(channelId)) {
				throw new Error(`Channel "${channelId}" has already taken the other role`);
			}

			const channel = guild.channels.get(channelId);

			if (!channel) throw new Error(`Channel "${channelId}" doesn't exist`);
		
			if (!(channel instanceof VoiceChannel)) {
				throw new Error(`Channel "${channelId}" (${channelRole}) must be voice channel`);
			}

			resolvingData.resolvedChannels[channelRole] = channel;

			const permissions = channel.permissionsFor(guild.me);

			if (!permissions) throw new Error(`Unable to determinate permissions for channel "${channelId}"`);

			if (!permissions.has("MANAGE_CHANNELS")) {
				StatsChannels._log("warn", `Bot will not be able to manage channel "${channelId}". Please check permissions!`);
			}

			loggedIDs.push(channelId);
		}

		return resolvingData;
	}

	private async _initLocalization(i: ModulePrivateInterface<StatsChannels>) {
		this._i18nUnhandle = await extendAndAssign([__dirname, "i18n"], i);
	}

	private async _initInterval() {
		if (this._updateInterval) {
			clearInterval(this._updateInterval);
		}

		await this._updateChannels();

		this._updateInterval = setInterval(
			() => this._updateChannels(),
			ONE_MINUTE
		);
	}

	private async _updateChannels() {
		const guild = this._managedGuild;

		if (!guild.available) {
			StatsChannels._log("warn", `Guild "${guild.id}" is unavailable`);

			return;
		}

		const resolvedChannels = this._resolvedChannels;

		this._updateMembersStatChannel(resolvedChannels.members);
		this._updateTimeStatChannel(resolvedChannels.time);
	}

	private async _updateMembersStatChannel(channel?: VoiceChannel) {
		if (!channel) { return; }

		if (this._deletionFearConfirms(channel, "time")) {
			return;
		}

		const guild = this._managedGuild;

		const generatedString = await localizeForGuild(
			guild,
			"DNSERV_STATCHANNEL_FORMAT_MEMBERS", {
				members: guild.memberCount
			}
		);

		return StatsChannels._updateChannelName(
			channel,
			generatedString
		);
	}

	private async _updateTimeStatChannel(channel?: VoiceChannel) {
		if (!channel) { return; }

		if (this._deletionFearConfirms(channel, "members")) {
			return;
		}

		const generatedString = await toGuildLocaleString(
			this._managedGuild,
			Date.now(),
			DateTime.DATETIME_SHORT
		);

		return StatsChannels._updateChannelName(
			channel,
			generatedString
		);
	}

	private static async _updateChannelName(channel: VoiceChannel, str: string) {
		if (channel.name === str) {
			return;
		}

		return channel.setName(str);
	}

	private _deletionFearConfirms(channel: VoiceChannel, type: keyof ResolvedChannels) {
		if (channel.deleted) {
			delete this._resolvedChannels[type];

			StatsChannels._log(
				"warn",
				`Resolved channel with ID "${channel.id}" for "${type}" is deleted.`
			);

			return true;
		}

		return false;
	}

	private static _msUntilNextMinute() {
		const d = new Date();

		const currentMilliseconds =
			(d.getSeconds() * 1000)
			+ d.getMilliseconds();

		return ONE_MINUTE - currentMilliseconds;
	}

	public async unload(i: ModulePrivateInterface<StatsChannels>) {
		if (i.baseCheck(this) && !i.isPendingUnload()) {
			throw new Error(
				ErrorMessages.NOT_PENDING_UNLOAD
			);
		}

		const {
			_scheduledIntervalInit: scheduledInit,
			_updateInterval: interval,
			_i18nUnhandle: i18nUnhandle
		} = this;

		if (scheduledInit) {
			clearTimeout(scheduledInit);
		}

		if (interval) {
			clearInterval(interval);
		}

		if (i18nUnhandle) {
			i18nUnhandle();
		}

		return true;
	}
}

type ResolvedChannels = StatsChannelsProto<VoiceChannel>;

export default StatsChannels;
