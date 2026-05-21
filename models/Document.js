const mongoose = require("mongoose");

const DocumentSchema = new mongoose.Schema(
{
userId: {
type: mongoose.Schema.Types.ObjectId,
ref: "User",
required: true
},

type: {
type: String,
default: "identity"
},

documentUrl: {
type: String,
required: true
},

status: {
type: String,
enum: ["pending", "approved", "rejected"],
default: "pending"
},

adminNote: {
type: String,
default: ""
}

},
{
timestamps: true
});

module.exports = mongoose.model("Document", DocumentSchema);
