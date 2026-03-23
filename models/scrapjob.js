'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ScrapJob extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // define association here
    }
  }
  ScrapJob.init({
    id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER,
      },
      universityName: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      url: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM("pending", "running", "completed", "failed"),
        defaultValue: "pending",
      },
      totalFound: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      pagesScraped: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
  }, {
    sequelize,
    modelName: 'ScrapJob',
    timestamps:true
  });
  return ScrapJob;
};