import * as getLogger from "loggy";
import { IModule } from "@sb-types/ModuleLoader/Interfaces.new";
import { ErrorMessages } from "@sb-types/Consts";
import { default as fetch } from "node-fetch";
import { GuildMember, Message } from "discord.js";
import { resolveGuildMember, EmbedType, getMessageMember } from "@utils/utils";
import { MessagesFlows, IPublicFlowCommand, IMessageFlowContext } from "@cogs/cores/messagesFlows/messagesFlows";
import { extendAndAssign, generateLocalizedEmbed, localizeForGuild, localizeForUser } from "@utils/ez-i18n";
import { ModulePrivateInterface } from "@sb-types/ModuleLoader/PrivateInterface";
import * as config from "@utils/config";

interface IOptions {
	/**
	 * Guild ID for which this plugin is initializing
	 */
	guildId: string;
	/**
	 * Token of the user that will be used to check the house
	 *
	 * We're NOT providing any instructions how to get your token
	 *
	 * Please, create a separate account, verify e-mails and join needed servers
	 */
	token: string;
	/**
	 * Roles for houses
	 */
	roles: Partial<Roles>;
}

type Roles = {
	balance: string;
	bravery: string;
	brilliance: string;
};

export class HouseRoles implements IModule<HouseRoles> {
	private static readonly _log = getLogger("dnSERV: HouseRole");

	private _guildId: string;
	private _userToken: string;
	private _houseRoles: Roles;

	private _unloaded = false;
	private _flowHandler?: IPublicFlowCommand;
	private _i18nUnhandle: () => string[];

	public async init(i: ModulePrivateInterface<HouseRoles>) {
		if (i.baseCheck(this) && !i.isPendingInitialization()) {
			throw new Error(ErrorMessages.NOT_PENDING_INITIALIZATION);
		}

		// Retreiving the configuration
		const cfg = (await config.instant<IOptions>(i))[1];

		if (!cfg) {
			// If config doesn't exist, then making an example one

			const cfgPath = await config.saveInstant<IOptions>(i, {
				guildId: "SERVER ID",
				roles: {
					balance: "ID FOR BALANCE ROLE",
					bravery: "ID FOR BRAVERY ROLE",
					brilliance: "ID FOR BRILLIANCE ROLE"
				},
				token: "PUT THE DISCORD ACCOUNT TOKEN HERE"
			});

			HouseRoles._log("err", `No configuration found. An example config created at ${cfgPath}, please replace needed values before starting bot again`);

			throw new Error("No configuration file found. An example config created");
		}

		// Checking the config
		const { token, guildId } = cfg;

		if (!token) {
			throw new Error("No token provided. User token required to fetch person's houses");
		}

		// Check if the guild provided and valid
		if (!guildId) throw new Error(`No guild ID provided`);

		this._guildId = guildId;

		const guild = $discordBot.guilds.get(guildId);

		if (!guild) {
			if ($botConfig.sharded) {
				HouseRoles._log(
					"warn",
					`Guild ${guildId} is not present on this shard`
					);
					
					return;
			}
			
			throw new Error(`Guild "${guildId}" not found`);
		}

		// Guild found, see if the user in the guild too
		await HouseRoles._checkToken(token, guildId);

		this._userToken = token;

		// Now checking the roles
		const { roles } = cfg;

		if (!roles) throw new Error("No roles provided in config");

		for (let i = 0, l = HOUSE_ROLES.length; i < l; i++) {
			const houseName = HOUSE_ROLES[i];
			
			const houseRole = roles[houseName];
			
			if (!houseRole) throw new Error(`No role set for "${houseName}"`);
			
			if (!guild.roles.has(houseRole)) {
				throw new Error(`Role "${houseRole}" cannot be found on "${guildId}"`);
			}
		}

		this._houseRoles = <Roles> roles;

		// Basic stuff of registering locales, commands yada yada
		this._i18nUnhandle = await extendAndAssign([__dirname, "i18n"], i);

		const mf = i.getDependency<MessagesFlows>("messages-flows");

		if (!mf) throw new Error("Cannot find MessagesFlows Keeper");

		mf.onInit((base) => {
			const handler = base.watchForCommands(
				(ctx) => this._onMessage(ctx),
				"houserole"
			);

			if (this._unloaded) {
				handler.unhandle();

				return;
			}

			this._flowHandler = handler;
		});
	}

	private async _onMessage(ctx: IMessageFlowContext) {
		// 1. Called without any arguments → self-assign
		// 2. Called with subcommand of "remove" → remove roles
		//  2.1. … and argument of user mention (admin) → … of that user
		// 3. Called with subcommand of "assign"
		//    and user mention (admin) → assign role to user

		const { parsed, message } = ctx;

		if (!message.guild || message.guild.id !== this._guildId) {
			return;
		}

		const { arguments: args } = parsed;

		try {
			return await (() => {
				switch (parsed.subCommand) {
					case null:
						return this._selfAssign(ctx);
					case "assign":
						return args ?
							this._assignTo(ctx) :
							this._selfAssign(ctx);
					case "remove":
						return args ?
							this._deassignFrom(ctx) :
							this._selfDeassign(ctx);
					default:
						return this._invalidSubCmd(ctx);
				}
			})();
		} catch (err) {
			HouseRoles._log("err", "Failed to execute command", err);
		}
	}

	// #region UX handling

	/**
	 * Whenever the wrong subcommand called
	 */
	private async _invalidSubCmd(ctx: IMessageFlowContext) {
		const { message: msg } = ctx;

		const sender = await getMessageMember(ctx.message);

		if (!sender) {
			return;
		}

		return msg.channel.send({
			embed: await generateLocalizedEmbed(
				EmbedType.Information,
				sender,
				"DNSERV_HOUSEROLE_UNKNOWN_SUBCMD"
			)
		});
	}

	/**
	 * Assigns House Roles for the member per their request
	 */
	private async _selfAssign(ctx: IMessageFlowContext) {
		const { message: msg } = ctx;

		const sender = await getMessageMember(msg);

		if (!sender) { return; }

		let assignResult: AssignResult;

		try {
			assignResult = await this._assign(sender);
		} catch (err) {
			return HouseRoles._onError(
				msg, sender,
				err, "self"
			);
		}

		const currentHouses = assignResult[1];

		return msg.channel.send({
			embed: (
				currentHouses != null ?
					await generateLocalizedEmbed(
						EmbedType.OK,
						sender, {
							key: "DNSERV_HOUSEROLE_ASSIGNED@SELF",
							formatOptions: {
								...(
									await HouseRoles._housesArgs(
										currentHouses,
										sender
									)
								)
							}
						}
					) :
					await generateLocalizedEmbed(
						EmbedType.Error,
						sender,
						"DNSERV_HOUSEROLE_ERR_NOHOUSE@SELF"
					)
			)
		});
	}

	/**
	 * Removes House Roles from the member per their request
	 */
	private async _selfDeassign(ctx: IMessageFlowContext) {
		const { message: msg } = ctx;

		const sender = await getMessageMember(msg);

		if (!sender) { return; }

		let deassignResult: DeassignResult;

		try {
			deassignResult = await this._deassign(sender);
		} catch (err) {
			return HouseRoles._onError(
				msg, sender,
				err, "self"
			);
		}

		return msg.channel.send({
			embed: await (
				deassignResult == null ?
					generateLocalizedEmbed(
						EmbedType.Error,
						sender,
						"DNSERV_HOUSEROLE_ERR_NOHOUSE@SELF"
					) :
					generateLocalizedEmbed(
						EmbedType.OK,
						sender, {
							key: "DNSERV_HOUSEROLE_DEASSIGN@SELF",
							formatOptions: {
								...(
									await HouseRoles._housesArgs(
										deassignResult,
										sender
									)
								)
							}
						}
					)
			)
		});
	}

	/**
	 * Assigns House Roles for the member per manager request
	 */
	private async _assignTo(ctx: IMessageFlowContext) {
		const { message: msg } = ctx;

		const sender = await getMessageMember(msg);

		if (!sender) { return; }

		const { parsed } = ctx;

		const { arguments: args } = parsed;

		const proposal = args ? args[0] : null;

		if (!proposal) {
			return this._selfAssign(ctx);
		}

		const resolvedProposal = await resolveGuildMember(
			proposal.value,
			msg.guild, {
				strict: false,
				caseStrict: false,
				fetch: false,
				possibleMention: true
			}
		);

		if (!resolvedProposal) {
			return msg.channel.send({
				embed: await generateLocalizedEmbed(
					EmbedType.Error,
					sender,
					"DNSERV_HOUSEROLE_UNKNOWN_PROPOSE"
				)
			});
		}

		if (!canManageHouseRole(sender)) {
			if (resolvedProposal.id !== sender.id) {
				// silently ignore
				return;
			}

			return this._selfAssign(ctx);
		}

		let assignResult: AssignResult;

		try {
			assignResult = await this._assign(resolvedProposal);
		} catch (err) {
			return HouseRoles._onError(
				msg, sender,
				err, "managed"
			);
		}

		const currentHouses = assignResult[1];

		return msg.channel.send({
			embed: await (
				currentHouses != null ?
					generateLocalizedEmbed(
						EmbedType.OK,
						sender, {
							key: "DNSERV_HOUSEROLE_ASSIGNED@OTHER",
							formatOptions: {
								...(
									await HouseRoles._housesArgs(
										currentHouses,
										sender
									)
								),
								username: resolvedProposal.toString()
							}
						}
					) :
					generateLocalizedEmbed(
						EmbedType.Error,
						sender, {
							key: "DNSERV_HOUSEROLE_ERR_NOHOUSE@OTHER",
							formatOptions: {
								username: resolvedProposal.toString()
							}
						}
					)
			)
		});
	}

	/**
	 * Removes House Roles from the member per manager request
	 */
	private async _deassignFrom(ctx: IMessageFlowContext) {
		const { message: msg } = ctx;

		const sender = await getMessageMember(msg);

		if (!sender) { return; }

		const { parsed } = ctx;

		const { arguments: args } = parsed;

		const proposal = args ? args[0].value : null;

		if (!proposal) {
			return this._selfDeassign(ctx);
		}

		const resolvedProposal = await resolveGuildMember(
			proposal,
			msg.guild, {
				strict: false,
				caseStrict: false,
				fetch: false,
				possibleMention: true
			}
		);

		if (!resolvedProposal) {
			return msg.channel.send({
				embed: await generateLocalizedEmbed(
					EmbedType.Error,
					sender,
					"DNSERV_HOUSEROLE_UNKNOWN_PROPOSE"
				)
			});
		}

		if (!canManageHouseRole(sender)) {
			if (resolvedProposal.id !== sender.id) {
				// silently ignore
				return;
			}

			return this._selfDeassign(ctx);
		}

		let deassignResult: DeassignResult;

		try {
			deassignResult = await this._deassign(resolvedProposal);
		} catch (err) {
			return HouseRoles._onError(
				msg, sender,
				err, "managed"
			);
		}

		return msg.channel.send({
			embed: await (
				deassignResult == null ?
					generateLocalizedEmbed(
						EmbedType.Error,
						sender, {
							key: "DNSERV_HOUSEROLE_ERR_NOROLES@OTHER",
							formatOptions: {
								username: resolvedProposal.toString()
							}
						}
					) :
					generateLocalizedEmbed(
						EmbedType.OK,
						sender, {
							key: "DNSERV_HOUSEROLE_DEASSIGN@OTHER",
							formatOptions: {
								...(
									await HouseRoles._housesArgs(
										deassignResult,
										sender
									)
								),
								username: resolvedProposal.toString()
							}
						}
					)
			)
		});
	}

	private static async _onError(msg: Message, sender: GuildMember, err: Error, caller: "self" | "managed") {
		if (err instanceof HousesFetchError) {
			return msg.channel.send({
				embed: await generateLocalizedEmbed(
					EmbedType.Error,
					sender, {
						key: `DNSERV_HOUSEROLE_ERR_APIERR@${caller === "self" ? "SELF" : "OTHER"}`,
						formatOptions: {
							username: sender.toString()
						}
					}
				)
			});
		}

		return msg.channel.send({
			embed: await generateLocalizedEmbed(
				EmbedType.Error,
				sender,
				"DNSERV_HOUSEROLE_ERR_UNKNOWN"
			)
		});
	}

	// #region UX Helpful Functions

	private static async _housesArgs(houses: House[], sender: GuildMember) {
		const names: string[] = [];
		const rolesCount = houses.length;

		for (let i = 0; i < rolesCount; i++) {
			names.push(
				await HouseRoles._houseName(
					houses[i],
					sender
				)
			);
		}

		return {
			houses: names.join(
				await localizeForUser(
					sender,
					"DNSERV_HOUSEROLE_HOUSE+JOINER"
				)
			),
			rolesCount
		};
	}

	private static async _houseName(house: House, sender: GuildMember) {
		return localizeForUser(
			sender,
			`DNSERV_HOUSEROLE_HOUSE_${house.toUpperCase()}`
		);
	}

	// #endregion

	// #endregion

	// #region Backend

	// #region Role Manage

	// FIXME: remove useless `changes` and array with it
	/**
	 * Assigns House Roles to the member
	 *
	 * @returns Array of two elements: 0 — if there were any changes?
	 * 1 — current houses of the member, `null` if none
	 */
	private async _assign(member: GuildMember): Promise<AssignResult> {
		let changes = false;

		// Check member's roles

		const mRoles = this._memberHavesRoles(member);

		// Fetch their houses

		const mHouses = await HouseRoles._checkHouse(
			member.id, this._userToken
		);

		if (mRoles.length === 0 && mHouses.length === 0) {
			return [changes, null];
		}

		const houseRoles = this._houseRoles;

		for (let i = 0, l = HOUSE_ROLES.length; i < l; i++) {
			const house = HOUSE_ROLES[i];

			const hasRole = mRoles.includes(house);
			const inHouse = mHouses.includes(house);

			if (
				hasRole === inHouse
			) {
				continue;
			}

			const houseRole = houseRoles[house];

			if (!hasRole && inHouse) {
				await member.roles.add(
					houseRole,
					await localizeForGuild(
						member.guild,
						"DNSERV_HOUSEROLE_AUDITLOG@ASSIGN"
					)
				);
			} else if (hasRole && !inHouse) {
				await member.roles.remove(
					houseRole,
					await localizeForGuild(
						member.guild,
						"DNSERV_HOUSEROLE_AUDITLOG@DEASSIGN"
					)
				);
			}

			if (!changes) {
				changes = true;
			}
		}

		return [changes, mHouses];
	}

	/**
	 * Removed House Roles from the member
	 *
	 * @returns Array of Houses whose roles were deleted
	 */
	private async _deassign(member: GuildMember): Promise<DeassignResult> {
		const removedHouses: House[] = [];
		const houses = HOUSE_ROLES;
		const houseRoles = this._houseRoles;

		for (let i = 0, l = houses.length; i < l; i++) {
			const house = houses[i];
			const role = houseRoles[house];

			if (!member.roles.has(role)) {
				continue;
			}

			await member.roles.remove(
				role,
				await localizeForGuild(
					member.guild,
					"DNSERV_HOUSEROLE_AUDITLOG@DEASSIGN"
				)
			);

			removedHouses.push(house);
		}

		return removedHouses.length === 0 ? null : removedHouses;
	}

	private _memberHavesRoles(member: GuildMember) {
		const set: House[] = [];

		const houseRoles = this._houseRoles;

		for (const role in houseRoles) {
			if (member.roles.has(houseRoles[<keyof(Roles)> role])) {
				set.push(<House> role);
			}
		}

		return set;
	}

	// #endregion

	private static async _checkToken(token: string, guildId: string) {
		const guilds = await fetch(
			`https://discordapp.com/api/v6/users/@me/guilds`, {
				headers: {
					"Authorization": token
				}
			}
		).then(
			response => {
				if (response.status !== 200) {
					return Promise.reject(
						new GuildsFetchError()
					);
				}

				return response.json();
			}
		);

		for (let i = 0, l = guilds.length; i < l; i++) {
			const guild = guilds[i];
		
			if (guild.id === guildId) return true;
		}

		throw new Error(`Cannot find guild "${guildId}" using the user account`);
	}

	private static async _checkHouse(userId: string, token: string) {
		// https://discordapp.com/api/v6/users/${userId}/profile

		const profile = await fetch(
			`https://discordapp.com/api/v6/users/${userId}/profile`, {
				headers: {
					"Authorization": token
				}
			}
		).then((response) => {
			if (response.status !== 200) {
				return Promise.reject(
					new HousesFetchError()
				);
			}

			return response.json();
		});

		const { flags } = profile.user;

		const houses: House[] = [];

		if (hasFlag(flags, DiscordHouse.BALANCE)) {
			houses.push("balance");
		}

		if (hasFlag(flags, DiscordHouse.BRAVERY)) {
			houses.push("bravery");
		}

		if (hasFlag(flags, DiscordHouse.BRILLIANCE)) {
			houses.push("brilliance");
		}

		return houses;
	}

	// #endregion

	public unload(i: ModulePrivateInterface<HouseRoles>) {
		if (i.baseCheck(this) && !i.isPendingUnload()) {
			throw new Error(ErrorMessages.NOT_PENDING_UNLOAD);
		}

		if (this._flowHandler) this._flowHandler.unhandle();

		if (this._i18nUnhandle) this._i18nUnhandle();

		this._unloaded = true;

		return true;
	}
}

function canManageHouseRole(member: GuildMember) {
	return member.permissions.has("MANAGE_ROLES");
}

function hasFlag(flags: number, flag: number) {
	return (flags & flag) === flag;
}

type House = keyof Roles;

const HOUSE_ROLES: House[] = [
	"balance",
	"bravery",
	"brilliance"
];

export const enum DiscordHouse {
	BALANCE = 256,
	BRILLIANCE = 128,
	BRAVERY = 64
}

type DeassignResult = House[] | null;
type AssignResult = [boolean, House[] | null];

class HousesFetchError extends Error { }
class GuildsFetchError extends Error { }

export default HouseRoles;
