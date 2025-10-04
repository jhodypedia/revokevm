import { DataTypes } from "sequelize";
import sequelize from "../index.js";

const RpcEndpoint = sequelize.define("RpcEndpoint", {
  chain_id: { type: DataTypes.INTEGER, allowNull: false },
  chain_name: { type: DataTypes.STRING, allowNull: false },
  rpc_url: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.ENUM("ok", "slow", "down"), defaultValue: "ok" },
  latency_ms: { type: DataTypes.INTEGER, allowNull: true },
  last_checked: { type: DataTypes.DATE, allowNull: true },
  priority: { type: DataTypes.INTEGER, defaultValue: 100 } // makin kecil makin prioritas
}, {
  tableName: "rpc_endpoints",
  indexes: [
    { fields: ["chain_id"] },
    { fields: ["status"] }
  ]
});

export default RpcEndpoint;
