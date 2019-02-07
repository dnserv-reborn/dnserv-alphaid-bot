import { getDB } from "@utils/db";
import { GuildMember } from "discord.js";
import { INullableHashMap } from "@sb-types/Types";
import * as logger from "loggy";

const DB = getDB();

export const DEFAULT_TABLE_NAME = "houseRoles";

const TABLE_NAME = Symbol("tableName");
const LOCAL_CACHE = Symbol("localCache");
const INIT_COMPLETE = Symbol("initComplete");
const LOGGER = Symbol("logger");

type HouseRecord = {
	guildId: string;
	memberId: string;
	flags: number;
	when: number;
};

function mustBeInitialized(controller: HouseRolesDBController) {
	if (!controller[INIT_COMPLETE]) {
		throw new Error("Controller must be initialized first");
	}
}

export class HouseRolesDBController {
	// For the first time it only keeps recent House changes

	private [TABLE_NAME]: string;
	private [LOCAL_CACHE]: INullableHashMap<HouseRecord>;
	private [INIT_COMPLETE]: boolean;
	private [LOGGER]: logger.ILogFunction;

	constructor(tableName = DEFAULT_TABLE_NAME) {
		this[TABLE_NAME] = tableName;
		this[LOCAL_CACHE] = Object.create(null);
		this[LOGGER] = logger(`HouseRolesDBController{${tableName}}`);
		this[INIT_COMPLETE] = false;
	}

	private static getLocalKey(member: GuildMember) {
		return `${member.guild.id}:${member.id}`;
	}

	public async init() {
		if (this[INIT_COMPLETE]) {
			throw new Error("Controller is already initialized");
		}

		const tableName = this[TABLE_NAME];
		const log = this[LOGGER];

		if (!(await DB.schema.hasTable(tableName))) {
			log("info", "No table found, a new one will be created");

			await DB.schema.createTable(tableName, (tb) => {
				tb.string("guildId").notNullable();
				tb.string("memberId").notNullable();
				tb.integer("flags").notNullable();
				tb.integer("when").notNullable();
			});
		}

		log("ok", "Ready to work");

		this[INIT_COMPLETE] = true;
	}

	/**
	 * Records a house change for member
	 * @param member Member for who record being kept
	 */
	public async recordChange(member: GuildMember, flags: number) {
		mustBeInitialized(this);

		const remoteRecord = await this.getRecord(member, false);

		const newRecord = {
			guildId: member.guild.id,
			memberId: member.id,
			when: Date.now(),
			flags
		};

		const localKey = HouseRolesDBController.getLocalKey(member);

		if (remoteRecord) {
			await DB(this[TABLE_NAME])
				.where(remoteRecord)
				.update(newRecord);
		} else {
			await DB(this[TABLE_NAME]).insert(newRecord);
		}
		
		this[LOCAL_CACHE][localKey] = newRecord;
	}

	/**
	 * Gets house change record for the member
	 * @param member Member whose record to get
	 * @param useCache Whether should be cache used or not
	 */
	public async getRecord(member: GuildMember, useCache = true) : Promise<HouseRecord | undefined> {
		mustBeInitialized(this);

		const localKey = HouseRolesDBController.getLocalKey(member);
		const localValue = useCache && this[LOCAL_CACHE][localKey];

		if (localValue) return localValue;

		const remoteValue = await DB(this[TABLE_NAME]).where({
			guildId: member.guild.id,
			memberId: member.id
		}).first();

		if (!remoteValue) return;

		this[LOCAL_CACHE][localKey] = remoteValue;
	}
}

export default HouseRolesDBController;
